import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset, log } from 'crawlee';
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import { gotScraping } from 'got-scraping';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractEmails(text) {
    if (!text) return [];
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const found = text.match(emailRegex) || [];
    return [...new Set(
        found.filter(e =>
            !e.match(/\.(png|jpg|jpeg|gif|svg|webp|mp4|pdf)$/i) &&
            !e.includes('example.com') &&
            !e.includes('youremail') &&
            !e.startsWith('email@') &&
            e.length < 80
        )
    )];
}

function mergeEmails(...sources) {
    const all = [];
    for (const src of sources) {
        if (Array.isArray(src)) all.push(...src);
        else if (typeof src === 'string' && src.includes('@')) all.push(src);
    }
    return [...new Set(all.filter(Boolean))];
}

function isLinkAggregator(url) {
    if (!url) return false;
    return ['linktr.ee','bio.link','beacons.ai','solo.to','campsite.bio',
            'koji.to','taplink.cc','allmylinks.com','lnk.bio','msha.ke',
            'carrd.co','about.me','bento.me','milkshake.app','linkin.bio',
    ].some(a => url.includes(a));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Actor ────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput();
const {
    hashtags: seedHashtags = ['running','marathon','halfmarathon','runnersofinstagram','runningcoach'],
    minFollowers       = 5000,
    maxResults         = 10000,
    maxHashtags        = 500,
    maxPagesPerHashtag = 50,
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;

if (!sessionId) {
    log.error('sessionId is required!');
    await Actor.exit();
}

const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);

// ─── Launch browser ───────────────────────────────────────────────────────────

log.info('🌐 Launching browser...');
const proxyUrl  = await proxyConfig.newUrl('ig_browser');
const apiProxyUrl = await proxyConfig.newUrl('ig_api');
const proxyHost = proxyUrl ? new URL(proxyUrl) : null;

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled'],
    proxy: proxyHost ? {
        server:   `${proxyHost.protocol}//${proxyHost.host}`,
        username: proxyHost.username ? decodeURIComponent(proxyHost.username) : undefined,
        password: proxyHost.password ? decodeURIComponent(proxyHost.password) : undefined,
    } : undefined,
});

const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
});

await context.addCookies([
    { name: 'sessionid', value: sessionId,  domain: '.instagram.com', path: '/', httpOnly: true,  secure: true },
    ...(csrfToken ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }] : []),
]);

const igPage = await context.newPage();

log.info('📱 Establishing Instagram session...');
await igPage.goto('https://www.instagram.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
}).catch(e => log.warning(`Nav: ${e.message}`));

// ─── Instagram API caller with exponential backoff ────────────────────────────

async function igApiFetch(apiUrl, retryCount = 0) {
    try {
        const result = await igPage.evaluate(async (url) => {
            try {
                const r = await fetch(url, {
                    headers: {
                        'X-IG-App-ID': '936619743392459',
                        'X-ASBD-ID': '129477',
                        'X-IG-Capabilities': '3brTvw==',
                        'X-IG-Connection-Type': 'WiFi',
                        'Accept': '*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    credentials: 'include',
                });
                return { status: r.status, data: r.ok ? await r.json() : null };
            } catch (e) {
                return { status: 0, error: e.message };
            }
        }, apiUrl);

        // Handle rate limiting with exponential backoff
        if (result?.status === 429) {
            const waitMs = Math.min(30000 * Math.pow(2, retryCount), 300000); // 30s → 60s → 120s → max 5min
            log.warning(`⏳ Rate limited (429) — waiting ${waitMs/1000}s before retry ${retryCount + 1}/5...`);
            await sleep(waitMs);
            if (retryCount < 5) return igApiFetch(apiUrl, retryCount + 1);
            return null;
        }

        if (result?.status === 401 || result?.status === 403) {
            log.warning(`🔒 Auth error (${result.status}) — session may have expired`);
            return null;
        }

        if (result?.error || !result?.data) {
            return null;
        }

        return result.data;
    } catch (e) {
        log.warning(`igApiFetch error: ${e.message}`);
        return null;
    }
}

async function mobileApiFetch(apiUrl, retryCount = 0) {
    try {
        const response = await gotScraping({
            url: apiUrl,
            proxyUrl: apiProxyUrl,
            responseType: 'json',
            timeout: { request: 30000 },
            throwHttpErrors: false,
            headers: {
                'User-Agent': 'Instagram 302.0.0.23.111 Android (30/11; 420dpi; 1080x1920; samsung; SM-G973F; beyond1; exynos9820; en_US; 504085143)',
                'X-IG-App-ID': '567067343352427',
                'X-IG-Capabilities': '3brTvw==',
                'X-IG-Connection-Type': 'WIFI',
                'Accept-Language': 'en-US',
                'Cookie': [
                    `sessionid=${sessionId}`,
                    csrfToken ? `csrftoken=${csrfToken}` : '',
                ].filter(Boolean).join('; '),
            },
        });

        if (response.statusCode === 429) {
            const waitMs = Math.min(30000 * Math.pow(2, retryCount), 300000);
            log.warning(`⏳ Mobile API rate limited (429) — waiting ${waitMs/1000}s before retry ${retryCount + 1}/5...`);
            await sleep(waitMs);
            if (retryCount < 5) return mobileApiFetch(apiUrl, retryCount + 1);
            return null;
        }

        if (response.statusCode === 401 || response.statusCode === 403) {
            log.warning(`🔒 Mobile API auth error (${response.statusCode})`);
            return null;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) return null;
        return response.body;
    } catch (e) {
        log.warning(`mobileApiFetch error: ${e.message}`);
        return null;
    }
}

// ─── Fetch hashtag page (mobile first, web fallback) ─────────────────────────

function collectMediaUsernames(items = []) {
    const usernames = [];
    for (const item of items) {
        const media = item?.media ?? item?.media_or_ad ?? item;
        const candidates = [
            media?.user?.username,
            media?.owner?.username,
            item?.user?.username,
            item?.owner?.username,
        ];
        for (const username of candidates) {
            if (username) usernames.push(username);
        }
    }
    return usernames;
}

function getNextMaxId(data) {
    return data?.next_max_id
        ?? data?.nextMaxId
        ?? data?.next_page
        ?? data?.pagination?.next_max_id
        ?? null;
}

function hasMorePages(data, nextMaxId) {
    if (typeof data?.more_available === 'boolean') return data.more_available && !!nextMaxId;
    if (typeof data?.moreAvailable === 'boolean') return data.moreAvailable && !!nextMaxId;
    return !!nextMaxId;
}

async function fetchHashtagPage(tag, maxId, rankToken = randomUUID(), pageNum = 1) {
    const encodedTag = encodeURIComponent(tag);
    const encodedRankToken = encodeURIComponent(rankToken);
    const encodedMaxId = maxId ? `&max_id=${encodeURIComponent(maxId)}` : '';

    // Try both mobile tag-feed URL shapes. Instagram accepts different variants
    // depending on account/session state, but both need a stable rank_token.
    const mobileUrls = [
        `https://i.instagram.com/api/v1/feed/tag/${encodedTag}/?rank_token=${encodedRankToken}&ranked_content=true${encodedMaxId}`,
        `https://i.instagram.com/api/v1/feed/tag/?tag_name=${encodedTag}&rank_token=${encodedRankToken}&ranked_content=true${encodedMaxId}`,
    ];

    for (const mobileUrl of mobileUrls) {
        const mobileData = await mobileApiFetch(mobileUrl);
        if (mobileData) {
            const nextMaxId = getNextMaxId(mobileData);
            return {
                usernames: [...new Set([
                    ...collectMediaUsernames(mobileData?.items),
                    ...collectMediaUsernames(mobileData?.ranked_items),
                ])],
                nextMaxId,
                moreAvailable: hasMorePages(mobileData, nextMaxId),
                source: 'mobile',
            };
        }
    }

    // Web sections fallback. Unlike web_info, this is a paginated hashtag feed.
    let webUrl = `https://www.instagram.com/api/v1/tags/${encodedTag}/sections/?tab=recent&page=${pageNum}`;
    if (maxId) webUrl += `&max_id=${encodeURIComponent(maxId)}`;

    const webData = await igApiFetch(webUrl);
    if (webData) {
        const mediaItems = [];
        for (const section of (webData?.sections ?? webData?.data?.recent?.sections ?? [])) {
            for (const key of ['medias', 'fill_media', 'two_by_two_item']) {
                const value = section?.layout_content?.[key];
                if (Array.isArray(value)) mediaItems.push(...value);
                else if (value) mediaItems.push(value);
            }
        }
        const nextMaxId = getNextMaxId(webData);
        return {
            usernames: [...new Set(collectMediaUsernames(mediaItems))],
            nextMaxId,
            moreAvailable: hasMorePages(webData, nextMaxId),
            source: 'sections',
        };
    }

    // Last-resort first-page fallback so the actor can still verify auth and
    // collect something if Instagram rejects both paginated feed endpoints.
    if (!maxId) {
        const webInfoData = await igApiFetch(
            `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodedTag}`
        );
        if (webInfoData) {
            const mediaItems = [];
            for (const key of ['recent', 'top']) {
                for (const section of (webInfoData?.data?.[key]?.sections ?? [])) {
                    mediaItems.push(
                        ...(section?.layout_content?.medias ?? []),
                        ...(section?.layout_content?.fill_media ?? [])
                    );
                }
            }
            const nextMaxId = webInfoData?.data?.recent?.next_max_id ?? null;
            return {
                usernames: [...new Set(collectMediaUsernames(mediaItems))],
                nextMaxId,
                moreAvailable: false,
                source: 'web_info',
            };
        }
    }

    return null;
}

// ─── Discover related hashtags ────────────────────────────────────────────────

async function discoverRelatedHashtags(tag) {
    const discovered = new Set();
    const relData = await igApiFetch(
        `https://www.instagram.com/api/v1/tags/${encodeURIComponent(tag)}/related/`
    );
    for (const rel of (relData?.related_tags ?? [])) {
        const t = rel?.name?.toLowerCase().trim();
        if (t) discovered.add(t);
    }
    const searchData = await igApiFetch(
        `https://www.instagram.com/api/v1/tags/search/?q=${encodeURIComponent(tag)}&count=15`
    );
    for (const result of (searchData?.results ?? [])) {
        const t = result?.name?.toLowerCase().trim();
        if (t) discovered.add(t);
    }
    return [...discovered];
}

// ─── API test ─────────────────────────────────────────────────────────────────

log.info('🔍 Testing API...');
const testResult = await fetchHashtagPage('running', '');
if (!testResult) {
    log.error('❌ API test FAILED — get fresh sessionid + csrftoken from Chrome and try again.');
    await browser.close();
    await Actor.exit();
}
log.info(`✅ API working via [${testResult.source}]`);

// ─── State ────────────────────────────────────────────────────────────────────

const seenUsers    = new Set();
const seenHashtags = new Set();
const savedData    = new Map();
let   totalSaved   = 0;

const hashtagQueue = [...new Set(
    seedHashtags.map(t => t.replace(/^#/, '').toLowerCase().trim()).filter(Boolean)
)];

const estimatedUsers = Math.min(hashtagQueue.length, maxHashtags) * maxPagesPerHashtag * 12;

log.info(`\n🏃 Instagram Email Scraper v14`);
log.info(`   Seed hashtags      : ${hashtagQueue.length}`);
log.info(`   Max total hashtags : ${maxHashtags}`);
log.info(`   Pages per hashtag  : ${maxPagesPerHashtag}`);
log.info(`   Min followers      : ${minFollowers.toLocaleString()}`);
log.info(`   Max results        : ${maxResults}`);
log.info(`   Est. users found   : ~${estimatedUsers.toLocaleString()}`);

// ─── PHASE 1: Discover users ──────────────────────────────────────────────────

log.info(`\n📡 PHASE 1: Discovering users...`);
const profilesToCheck = [];

while (hashtagQueue.length > 0 && seenHashtags.size < maxHashtags) {
    if (profilesToCheck.length >= maxResults * 10) break;

    const tag = hashtagQueue.shift();
    if (!tag || seenHashtags.has(tag)) continue;
    seenHashtags.add(tag);

    log.info(`\n📌 [${seenHashtags.size}/${maxHashtags}] #${tag}`);

    // Discover related hashtags first
    if (seenHashtags.size < maxHashtags) {
        const related = await discoverRelatedHashtags(tag);
        let addedCount = 0;
        for (const relTag of related) {
            if (!seenHashtags.has(relTag) && !hashtagQueue.includes(relTag)) {
                hashtagQueue.push(relTag);
                addedCount++;
            }
        }
        if (addedCount > 0) log.info(`   🔍 +${addedCount} related tags → queue: ${hashtagQueue.length}`);
    }

    // Deep paginate this hashtag
    let pageNum = 0, nextMaxId = '', moreAvailable = true, totalThisTag = 0;
    const rankToken = randomUUID();
    const seenCursorsForTag = new Set();

    while (pageNum < maxPagesPerHashtag && moreAvailable) {
        pageNum++;
        const result = await fetchHashtagPage(tag, nextMaxId, rankToken, pageNum);

        if (!result) {
            log.warning(`   p${pageNum}: failed — stopping tag`);
            break;
        }

        let newCount = 0;
        for (const u of result.usernames) {
            if (!seenUsers.has(u)) {
                seenUsers.add(u);
                profilesToCheck.push(u);
                newCount++;
                totalThisTag++;
            }
        }

        log.info(`   p${pageNum} [${result.source}]: +${newCount} | tag: ${totalThisTag} | total: ${profilesToCheck.length} | next: ${result.nextMaxId ? '✅' : '❌'}`);

        if (!result.nextMaxId || !result.moreAvailable) {
            moreAvailable = false;
            break;
        }

        if (seenCursorsForTag.has(result.nextMaxId)) {
            log.warning(`   p${pageNum}: repeated cursor — stopping tag to avoid loop`);
            break;
        }
        seenCursorsForTag.add(result.nextMaxId);

        nextMaxId = result.nextMaxId;
        await sleep(600);
    }

    log.info(`   ✅ #${tag}: ${totalThisTag} users over ${pageNum} pages`);
    await sleep(400);
}

log.info(`\n👥 Phase 1 complete: ${profilesToCheck.length} users from ${seenHashtags.size} hashtags`);

// ─── PHASE 2: Check profiles (with proper rate limiting) ──────────────────────

log.info(`\n📡 PHASE 2: Checking ${profilesToCheck.length} profiles...`);
log.info(`   Rate limit strategy: 1.5s between calls, 30s cooldown every 100 profiles`);

const externalLinks  = [];
let   consecutiveFails = 0;

for (let i = 0; i < profilesToCheck.length; i++) {
    if (totalSaved >= maxResults) break;

    const username = profilesToCheck[i];

    // ── Cooldown every 100 profiles to avoid rate limiting ────────────────────
    if (i > 0 && i % 100 === 0) {
        log.info(`⏸️  Cooldown pause (${i}/${profilesToCheck.length} checked, ${totalSaved} saved)...`);
        await sleep(30000); // 30 second cooldown every 100 profiles
        consecutiveFails = 0;
    }

    // ── If too many consecutive failures, take a longer break ─────────────────
    if (consecutiveFails >= 20) {
        log.warning(`⚠️  ${consecutiveFails} consecutive failures — taking 2 min break...`);
        await sleep(120000);
        consecutiveFails = 0;
    }

    const data = await igApiFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
    );

    if (!data) {
        consecutiveFails++;
        await sleep(1500);
        continue;
    }

    consecutiveFails = 0;
    const user = data?.data?.user;
    if (!user) { await sleep(1500); continue; }

    const followerCount = user.edge_followed_by?.count ?? 0;
    if (followerCount < minFollowers) {
        await sleep(1500);
        continue;
    }

    const bio      = user.biography ?? '';
    const website  = user.external_url ?? '';
    const bioLinks = (user.bio_links ?? []).map(l => l.url).filter(Boolean);

    const businessEmail = user.business_email ?? '';
    const publicEmail   = user.public_email ?? '';
    const allEmails = mergeEmails(
        businessEmail, publicEmail,
        extractEmails(bio),
        extractEmails([website, ...bioLinks].join(' '))
    );

    const record = {
        username:          user.username ?? username,
        fullName:          user.full_name ?? '',
        profileUrl:        `https://www.instagram.com/${username}/`,
        followers:         followerCount,
        following:         user.edge_follow?.count ?? 0,
        posts:             user.edge_owner_to_timeline_media?.count ?? 0,
        bio,
        website,
        bioLinks:          bioLinks.join(', '),
        businessEmail,
        publicEmail,
        emails:            allEmails,
        hasEmail:          allEmails.length > 0,
        isVerified:        user.is_verified ?? false,
        isPrivate:         user.is_private ?? false,
        isBusinessAccount: user.is_business_account ?? false,
        businessCategory:  user.business_category_name ?? '',
        profilePicUrl:     user.profile_pic_url_hd ?? user.profile_pic_url ?? '',
        scrapedAt:         new Date().toISOString(),
    };

    await Dataset.pushData(record);
    savedData.set(record.username, record);
    totalSaved++;

    log.info(`✅ @${record.username} | ${followerCount.toLocaleString()} followers | Emails: ${allEmails.length ? allEmails.join(', ') : '—'} [${totalSaved}/${maxResults}]`);

    for (const extUrl of [website, ...bioLinks].filter(u => u?.startsWith('http'))) {
        externalLinks.push({ username: record.username, url: extUrl });
    }

    // 1.5 second delay between each profile check
    await sleep(1500);
}

await browser.close();
log.info(`\n✅ Phase 2 done. ${totalSaved} profiles saved. ${externalLinks.length} external links queued.`);

// ─── PHASE 3: Linktree / websites ────────────────────────────────────────────

if (externalLinks.length > 0) {
    log.info(`\n🔗 PHASE 3: Scraping ${externalLinks.length} external links...`);

    const extQueue = await RequestQueue.open('ext');
    for (const { username, url } of externalLinks) {
        await extQueue.addRequest({
            url,
            label: isLinkAggregator(url) ? 'LINKTREE' : 'WEBSITE',
            userData: { username },
            uniqueKey: `ext:${username}:${url}`,
        }).catch(() => {});
    }

    const extCrawler = new PlaywrightCrawler({
        requestQueue: extQueue,
        proxyConfiguration: proxyConfig,
        maxConcurrency: 3,                  // reduced from 5 to avoid overload
        requestHandlerTimeoutSecs: 60,      // increased from 45
        navigationTimeoutSecs: 45,          // increased from 25 — fixes most timeout failures
        maxRequestRetries: 2,               // increased from 1
        launchContext: {
            launchOptions: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] },
        },
        async requestHandler({ request, page }) {
            const { username: uname } = request.userData;
            try {
                await page.waitForLoadState('domcontentloaded', { timeout: 35000 }).catch(() => {});

                const { text, hrefs } = await page.evaluate(() => ({
                    text:  document.body?.innerText ?? '',
                    hrefs: [...document.querySelectorAll('a[href]')].map(a => a.href),
                }));

                const emails = new Set();
                for (const e of extractEmails(text)) emails.add(e);
                for (const href of hrefs) {
                    if (href.startsWith('mailto:')) {
                        emails.add(href.replace('mailto:', '').split('?')[0].trim());
                    }
                }

                if (emails.size > 0) {
                    log.info(`📧 @${uname}: ${[...emails].join(', ')}`);
                    const existing = savedData.get(uname);
                    if (existing) {
                        const merged = mergeEmails(existing.emails, [...emails]);
                        if (merged.length > existing.emails.length) {
                            existing.emails   = merged;
                            existing.hasEmail = true;
                            await Dataset.pushData({ ...existing, _updated: true });
                            savedData.set(uname, existing);
                        }
                    }
                }

                // Follow outbound links from Linktree
                if (request.label === 'LINKTREE') {
                    const outbound = await page.$$eval('a[href^="http"]', els =>
                        els.map(a => a.href).filter(h =>
                            !['instagram.com','linktree','facebook.com','twitter.com',
                              'x.com','tiktok.com','youtube.com','spotify.com'].some(d => h.includes(d))
                        ).slice(0, 3)
                    ).catch(() => []);
                    for (const url of outbound) {
                        await extQueue.addRequest({
                            url, label: 'WEBSITE',
                            userData: { username: uname },
                            uniqueKey: `ext:${uname}:${url}`,
                        }).catch(() => {});
                    }
                }
            } catch (e) {
                log.warning(`@${uname}: ${e.message}`);
            }
        },
        failedRequestHandler({ request }) {
            log.warning(`Skipped: ${request.url}`);
        },
    });

    await extCrawler.run();
    log.info(`✅ Phase 3 done.`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const { items } = await (await Dataset.open()).getData();
const unique = new Map();
for (const item of items) {
    if (!unique.has(item.username) || item._updated) unique.set(item.username, item);
}
const final     = [...unique.values()];
const withEmail = final.filter(i => i.hasEmail).length;
const hitRate   = final.length ? Math.round(withEmail / final.length * 100) : 0;

log.info(`\n🎉 All done!`);
log.info(`   Hashtags processed : ${seenHashtags.size}`);
log.info(`   Users scanned      : ${seenUsers.size}`);
log.info(`   Profiles saved     : ${final.length}`);
log.info(`   With email         : ${withEmail} (${hitRate}%)`);

await Actor.setValue('SUMMARY', {
    hashtagsProcessed: seenHashtags.size,
    profilesSaved:     final.length,
    withEmail,
    emailHitRate:      `${hitRate}%`,
    scanned:           seenUsers.size,
});

await Actor.exit();
