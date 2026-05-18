import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset, log } from 'crawlee';
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

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Build full cookie set ────────────────────────────────────────────────────
// Fetches instagram.com homepage to collect all required cookies,
// then merges with the user-provided sessionId and csrfToken.

async function buildFullCookies(sessionId, inputCsrfToken, proxyUrl) {
    log.info('🍪 Fetching Instagram homepage to collect full cookie set...');
    try {
        const res = await gotScraping.get('https://www.instagram.com/', {
            proxyUrl,
            followRedirect: true,
            headers: {
                'User-Agent': MOBILE_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': `sessionid=${sessionId}${inputCsrfToken ? `; csrftoken=${inputCsrfToken}` : ''}`,
            },
            timeout: { request: 20000 },
            throwHttpErrors: false,
        });

        // Parse all Set-Cookie headers from response
        const cookieMap = { sessionid: sessionId };

        // If user provided csrfToken, use it directly (most reliable)
        if (inputCsrfToken) cookieMap['csrftoken'] = inputCsrfToken;

        const setCookies = res.headers['set-cookie'] ?? [];
        for (const raw of setCookies) {
            const [nameVal] = raw.split(';');
            const eqIdx = nameVal.indexOf('=');
            if (eqIdx < 0) continue;
            const name = nameVal.slice(0, eqIdx).trim();
            const val  = nameVal.slice(eqIdx + 1).trim();
            // Don't overwrite user-provided csrfToken with fetched one
            if (name && val && !(name === 'csrftoken' && inputCsrfToken)) {
                cookieMap[name] = val;
            }
        }

        const cookieStr  = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
        const csrfToken  = cookieMap['csrftoken'] ?? '';

        log.info(`🍪 Cookies collected: ${Object.keys(cookieMap).join(', ')}`);
        log.info(`🍪 CSRF token: ${csrfToken ? '✅' : '❌ missing — provide it in Input'}`);

        return { cookieStr, csrfToken };
    } catch (e) {
        log.warning(`Cookie collection failed: ${e.message}`);
        // Fall back to just sessionid + user-provided csrfToken
        const cookieStr = `sessionid=${sessionId}${inputCsrfToken ? `; csrftoken=${inputCsrfToken}` : ''}`;
        return { cookieStr, csrfToken: inputCsrfToken ?? '' };
    }
}

// ─── Instagram API fetch ──────────────────────────────────────────────────────

async function igFetch(url, cookieStr, csrfToken, proxyUrl) {
    try {
        const res = await gotScraping.get(url, {
            proxyUrl,
            followRedirect: true,
            maxRedirects: 5,
            headers: {
                'User-Agent': MOBILE_UA,
                'X-IG-App-ID': '936619743392459',
                'X-IG-Capabilities': '3brTvw==',
                'X-IG-Connection-Type': 'WiFi',
                'X-ASBD-ID': '129477',
                'X-CSRFToken': csrfToken,
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.instagram.com/',
                'Origin': 'https://www.instagram.com',
                'Cookie': cookieStr,
            },
            timeout: { request: 25000 },
            throwHttpErrors: false,
        });

        const status = res.statusCode;

        if (status === 429) {
            log.warning('Rate limited (429) — waiting 15s...');
            await new Promise(r => setTimeout(r, 15000));
            return null;
        }

        if (status === 401 || status === 403) {
            log.warning(`Auth error (${status}) — session may be invalid`);
            return null;
        }

        if (status !== 200) {
            log.warning(`Status ${status} for ${url}`);
            return null;
        }

        const body = res.body?.trim() ?? '';

        // Check for HTML login page instead of JSON
        if (body.startsWith('<!DOCTYPE') || body.startsWith('<html')) {
            log.warning(`Got HTML instead of JSON — session expired or blocked`);
            return null;
        }

        if (!body.startsWith('{') && !body.startsWith('[')) {
            log.warning(`Unexpected response: ${body.substring(0, 100)}`);
            return null;
        }

        return JSON.parse(body);
    } catch (e) {
        log.warning(`igFetch error: ${e.message}`);
        return null;
    }
}

// ─── Actor ────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput();
const {
    hashtags = [
        'running','marathon','halfmarathon','runningcommunity',
        'runnersofinstagram','ultramarathon','trailrunning',
        'runnerlife','runningmotivation','roadrunning',
        'marathontraining','runningcoach','runningwomen',
        'instarunners','runner','runhappy','marathonrunner',
        'halfmarathontraining','runningdaily','trailrunner',
        'runninglifestyle','morningrun','runningislife',
        'marathoners','runningworld','bostonmarathon',
        'runforlife','runningmen','hyrox','runcoach',
    ],
    minFollowers       = 5000,
    maxResults         = 500,
    maxPagesPerHashtag = 10,
    sessionId,
    csrfToken: inputCsrfToken,      // ← correctly read from input
    proxyConfiguration,
} = input;

if (!sessionId) {
    log.error('sessionId is required! Add your Instagram sessionid cookie in Input.');
    await Actor.exit();
}

const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);
const proxyUrl = await proxyConfig.newUrl('ig_main');

// ─── Collect full cookie set ──────────────────────────────────────────────────

const { cookieStr, csrfToken } = await buildFullCookies(sessionId, inputCsrfToken, proxyUrl);

// ─── Quick API test ───────────────────────────────────────────────────────────

log.info('🔍 Testing Instagram API...');
const testData = await igFetch(
    'https://www.instagram.com/api/v1/tags/web_info/?tag_name=running',
    cookieStr, csrfToken, proxyUrl
);

if (!testData) {
    log.error('❌ API test FAILED. Please:');
    log.error('   1. Get a FRESH sessionid — open Chrome Console on instagram.com and run:');
    log.error('      document.cookie.split(";").find(c=>c.trim().startsWith("sessionid")).split("=")[1]');
    log.error('   2. Get a FRESH csrftoken — run:');
    log.error('      document.cookie.split(";").find(c=>c.trim().startsWith("csrftoken")).split("=")[1]');
    log.error('   3. Paste both values into the Input fields and run again.');
    await Actor.exit();
} else {
    const sampleCount = testData?.data?.recent?.sections?.length ?? 0;
    log.info(`✅ API working! Got ${sampleCount} sections for #running`);
}

// ─── State ────────────────────────────────────────────────────────────────────

const seenUsers  = new Set();
const savedData  = new Map();
let   totalSaved = 0;

log.info(`\n🏃 Instagram Email Scraper v9 (fixed)`);
log.info(`   Hashtags      : ${hashtags.length}`);
log.info(`   Pages/hashtag : ${maxPagesPerHashtag}`);
log.info(`   Min followers : ${minFollowers.toLocaleString()}`);
log.info(`   Max results   : ${maxResults}`);

// ─── PHASE 1: Discover users via hashtags ─────────────────────────────────────

log.info(`\n📡 PHASE 1: Discovering users...`);
const profilesToCheck = [];

for (const rawTag of hashtags) {
    if (profilesToCheck.length >= maxResults * 5) break;
    const tag = rawTag.replace(/^#/, '').toLowerCase().trim();
    if (!tag) continue;

    log.info(`\n📌 #${tag}`);
    let maxId   = '';
    let pageNum = 0;

    while (pageNum < maxPagesPerHashtag) {
        pageNum++;
        let url = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
        if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;

        const data = await igFetch(url, cookieStr, csrfToken, proxyUrl);

        // GraphQL fallback if v1 fails
        if (!data) {
            let gqlUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/?__a=1&__d=dis`;
            if (maxId) gqlUrl += `&max_id=${encodeURIComponent(maxId)}`;
            const gql = await igFetch(gqlUrl, cookieStr, csrfToken, proxyUrl);

            if (!gql) {
                log.warning(`#${tag} p${pageNum}: both APIs failed — moving on`);
                break;
            }

            const edges = gql?.graphql?.hashtag?.edge_hashtag_to_media?.edges
                       || gql?.data?.hashtag?.edge_hashtag_to_media?.edges || [];
            for (const e of edges) {
                const u = e?.node?.owner?.username;
                if (u && !seenUsers.has(u)) { seenUsers.add(u); profilesToCheck.push(u); }
            }
            maxId = gql?.graphql?.hashtag?.edge_hashtag_to_media?.page_info?.end_cursor || '';
            if (!maxId) break;
            await new Promise(r => setTimeout(r, 700));
            continue;
        }

        // v1 API success
        const nextMaxId = data?.data?.recent?.next_max_id || null;
        let count = 0;
        for (const key of ['recent', 'top']) {
            for (const section of (data?.data?.[key]?.sections || [])) {
                for (const m of [
                    ...(section?.layout_content?.medias || []),
                    ...(section?.layout_content?.fill_media || []),
                ]) {
                    const u = (m?.media?.user || m?.media?.owner)?.username;
                    if (u && !seenUsers.has(u)) { seenUsers.add(u); profilesToCheck.push(u); count++; }
                }
            }
        }

        log.info(`#${tag} p${pageNum}: +${count} users (total: ${profilesToCheck.length}) | next: ${nextMaxId ? '✅' : '❌'}`);
        if (!nextMaxId) break;
        maxId = nextMaxId;
        await new Promise(r => setTimeout(r, 700));
    }
}

log.info(`\n👥 Discovered ${profilesToCheck.length} unique users`);

// ─── PHASE 2: Fetch profiles ──────────────────────────────────────────────────

log.info(`\n📡 PHASE 2: Checking ${profilesToCheck.length} profiles...`);
const externalLinks = [];

for (const username of profilesToCheck) {
    if (totalSaved >= maxResults) break;

    const data = await igFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        cookieStr, csrfToken, proxyUrl
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

    await new Promise(r => setTimeout(r, 300));
}

log.info(`\n✅ Phase 2 done. ${totalSaved} profiles saved.`);

// ─── PHASE 3: Linktree / websites ────────────────────────────────────────────

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
                // Follow outbound links from Linktree to personal sites
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
log.info(`   Profiles saved : ${final.length}`);
log.info(`   With email     : ${withEmail} (${hitRate}%)`);
log.info(`   Users scanned  : ${seenUsers.size}`);

await Actor.setValue('SUMMARY', {
    profilesSaved: final.length,
    withEmail,
    emailHitRate:  `${hitRate}%`,
    scanned:       seenUsers.size,
});

await Actor.exit();
