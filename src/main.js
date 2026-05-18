import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset, log } from 'crawlee';
import { chromium } from 'playwright';

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

// ─── Actor ────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput();
const {
    hashtags: seedHashtags = ['running','marathon','halfmarathon','runnersofinstagram','runningcoach'],
    minFollowers       = 5000,
    maxResults         = 10000,
    maxHashtags        = 50,    // total hashtags including auto-discovered
    maxPagesPerHashtag = 100,    // pages per hashtag via mobile API (~12 users/page)
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

// ─── Instagram API caller ─────────────────────────────────────────────────────

async function igApiFetch(apiUrl) {
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
                if (!r.ok) return { error: r.status };
                return { data: await r.json() };
            } catch (e) {
                return { error: e.message };
            }
        }, apiUrl);
        if (result?.error) { log.warning(`API ${result.error} → ${apiUrl}`); return null; }
        return result?.data ?? null;
    } catch (e) {
        log.warning(`igApiFetch: ${e.message}`);
        return null;
    }
}

// ─── Fetch one page of hashtag posts — tries mobile API first, falls back to web ──

async function fetchHashtagPage(tag, maxId) {
    // PRIMARY: Instagram mobile feed API (deep pagination support)
    let url = `https://i.instagram.com/api/v1/feed/tag/?tag_name=${encodeURIComponent(tag)}&rank_token=&ranked_content=true`;
    if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;

    const mobileData = await igApiFetch(url);
    if (mobileData) {
        const usernames = [];
        for (const item of (mobileData?.items ?? [])) {
            const u = item?.user?.username || item?.owner?.username;
            if (u) usernames.push(u);
        }
        return {
            usernames,
            nextMaxId:     mobileData?.next_max_id ?? null,
            moreAvailable: mobileData?.more_available ?? false,
            source:        'mobile',
        };
    }

    // FALLBACK: web API
    let webUrl = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
    if (maxId) webUrl += `&max_id=${encodeURIComponent(maxId)}`;

    const webData = await igApiFetch(webUrl);
    if (webData) {
        const usernames = [];
        for (const key of ['recent', 'top']) {
            for (const section of (webData?.data?.[key]?.sections ?? [])) {
                for (const m of [
                    ...(section?.layout_content?.medias ?? []),
                    ...(section?.layout_content?.fill_media ?? []),
                ]) {
                    const u = (m?.media?.user || m?.media?.owner)?.username;
                    if (u) usernames.push(u);
                }
            }
        }
        return {
            usernames,
            nextMaxId:     webData?.data?.recent?.next_max_id ?? null,
            moreAvailable: !!webData?.data?.recent?.next_max_id,
            source:        'web',
        };
    }

    return null;
}

// ─── Discover related hashtags for a given tag ────────────────────────────────

async function discoverRelatedHashtags(tag) {
    const discovered = new Set();

    // Source 1: related tags API
    const relData = await igApiFetch(
        `https://www.instagram.com/api/v1/tags/${encodeURIComponent(tag)}/related/`
    );
    for (const rel of (relData?.related_tags ?? [])) {
        const t = rel?.name?.toLowerCase().trim();
        if (t) discovered.add(t);
    }

    // Source 2: tag search/suggest API
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
    log.error('   sessionid: document.cookie.split(";").find(c=>c.trim().startsWith("sessionid")).split("=")[1]');
    log.error('   csrftoken: document.cookie.split(";").find(c=>c.trim().startsWith("csrftoken")).split("=")[1]');
    await browser.close();
    await Actor.exit();
}
log.info(`✅ API working via [${testResult.source}] — ${testResult.usernames.length} users on test page | pagination: ${testResult.nextMaxId ? '✅' : '❌'}`);

// ─── State ────────────────────────────────────────────────────────────────────

const seenUsers    = new Set();
const seenHashtags = new Set();
const savedData    = new Map();
let   totalSaved   = 0;

// Build hashtag queue from seeds — will grow as related tags are discovered
const hashtagQueue = [...new Set(
    seedHashtags.map(t => t.replace(/^#/, '').toLowerCase().trim()).filter(Boolean)
)];

const estimatedUsers = Math.min(hashtagQueue.length, maxHashtags) * maxPagesPerHashtag * 12;

log.info(`\n🏃 Instagram Email Scraper v13`);
log.info(`   Seed hashtags      : ${hashtagQueue.length}`);
log.info(`   Max total hashtags : ${maxHashtags} (seeds + auto-discovered)`);
log.info(`   Pages per hashtag  : ${maxPagesPerHashtag} (~${maxPagesPerHashtag * 12} users/tag)`);
log.info(`   Min followers      : ${minFollowers.toLocaleString()}`);
log.info(`   Max results        : ${maxResults}`);
log.info(`   Est. users found   : ~${estimatedUsers.toLocaleString()}`);

// ─── PHASE 1: Discover users (deep pagination + related hashtag discovery) ────

log.info(`\n📡 PHASE 1: Discovering users...`);
const profilesToCheck = [];

while (hashtagQueue.length > 0 && seenHashtags.size < maxHashtags) {
    if (profilesToCheck.length >= maxResults * 10) break;

    const tag = hashtagQueue.shift();
    if (!tag || seenHashtags.has(tag)) continue;
    seenHashtags.add(tag);

    const tagNum = seenHashtags.size;
    log.info(`\n📌 [${tagNum}/${maxHashtags}] #${tag}`);

    // ── Step A: Discover related hashtags FIRST (expands queue before we paginate) ──
    if (seenHashtags.size < maxHashtags) {
        const related = await discoverRelatedHashtags(tag);
        let addedCount = 0;
        for (const relTag of related) {
            if (!seenHashtags.has(relTag) && !hashtagQueue.includes(relTag)) {
                hashtagQueue.push(relTag);
                addedCount++;
            }
        }
        if (addedCount > 0) {
            log.info(`   🔍 Discovered ${addedCount} related hashtags → queue now ${hashtagQueue.length} tags`);
        }
    }

    // ── Step B: Deep paginate this hashtag using mobile feed API ─────────────
    let pageNum       = 0;
    let nextMaxId     = '';
    let moreAvailable = true;
    let totalThisTag  = 0;

    while (pageNum < maxPagesPerHashtag && moreAvailable) {
        pageNum++;

        const result = await fetchHashtagPage(tag, nextMaxId);

        if (!result) {
            log.warning(`   #${tag} p${pageNum}: API failed — stopping`);
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

        log.info(`   p${pageNum} [${result.source}]: +${newCount} users | tag total: ${totalThisTag} | grand total: ${profilesToCheck.length} | next: ${result.nextMaxId ? '✅' : '❌'}`);

        if (!result.nextMaxId || !result.moreAvailable || newCount === 0) {
            moreAvailable = false;
            break;
        }

        nextMaxId     = result.nextMaxId;
        moreAvailable = result.moreAvailable;

        // Small delay between pages to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
    }

    log.info(`   ✅ #${tag} complete: ${totalThisTag} users over ${pageNum} pages`);
    await new Promise(r => setTimeout(r, 400));
}

log.info(`\n👥 Phase 1 complete!`);
log.info(`   Hashtags processed : ${seenHashtags.size}`);
log.info(`   Total users found  : ${profilesToCheck.length}`);

// ─── PHASE 2: Check profiles ──────────────────────────────────────────────────

log.info(`\n📡 PHASE 2: Checking ${profilesToCheck.length} profiles (min ${minFollowers.toLocaleString()} followers)...`);
const externalLinks = [];

for (const username of profilesToCheck) {
    if (totalSaved >= maxResults) break;

    const data = await igApiFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
    );
    const user = data?.data?.user;
    if (!user) { log.debug(`@${username}: no data`); continue; }

    const followerCount = user.edge_followed_by?.count ?? 0;
    if (followerCount < minFollowers) { log.debug(`@${username}: ${followerCount} — skip`); continue; }

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

    await new Promise(r => setTimeout(r, 250));
}

await browser.close();
log.info(`\n✅ Phase 2 done. ${totalSaved} profiles saved.`);

// ─── PHASE 3: Linktree / websites for extra emails ────────────────────────────

if (externalLinks.length > 0) {
    log.info(`\n🔗 PHASE 3: Scraping ${externalLinks.length} external links for emails...`);

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
        maxConcurrency: 5,
        requestHandlerTimeoutSecs: 45,
        navigationTimeoutSecs: 25,
        maxRequestRetries: 1,
        launchContext: {
            launchOptions: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] },
        },
        async requestHandler({ request, page }) {
            const { username: uname } = request.userData;
            try {
                await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
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
        failedRequestHandler({ request }) { log.warning(`Skipped: ${request.url}`); },
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
