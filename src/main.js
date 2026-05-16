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

// ─── Instagram HTTP helper (no browser, just direct API calls) ────────────────

async function igFetch(url, sessionId, csrfToken, proxyUrl) {
    try {
        const res = await gotScraping.get(url, {
            proxyUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'X-IG-App-ID': '936619743392459',
                'X-ASBD-ID': '129477',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.instagram.com/',
                'Origin': 'https://www.instagram.com',
                'Cookie': `sessionid=${sessionId}${csrfToken ? `; csrftoken=${csrfToken}` : ''}`,
            },
            timeout: { request: 20000 },
            throwHttpErrors: false,
        });
        if (res.statusCode !== 200) return null;
        return JSON.parse(res.body);
    } catch {
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
    maxResults         = 100000,
    maxPagesPerHashtag = 50,
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;

if (!sessionId) {
    log.error('sessionId is required! Add your Instagram sessionid cookie in the Input.');
    await Actor.exit();
}

// ─── Proxy setup ──────────────────────────────────────────────────────────────

const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);

// Get a single proxy URL for gotScraping HTTP calls
const proxyUrl = await proxyConfig.newUrl('instagram_session');

// ─── State ────────────────────────────────────────────────────────────────────

const seenUsers = new Set();
const savedData = new Map();
let   totalSaved = 0;

// ─── PHASE 1: Discover users via Instagram API (pure HTTP, no browser) ────────

log.info(`🏃 Instagram Email Scraper v7`);
log.info(`   Hashtags      : ${hashtags.length} tags`);
log.info(`   Pages/hashtag : ${maxPagesPerHashtag} (~${maxPagesPerHashtag * 20} users/tag)`);
log.info(`   Min followers : ${minFollowers.toLocaleString()}`);
log.info(`   Max results   : ${maxResults}`);
log.info(`\n📡 PHASE 1: Discovering users via Instagram API...`);

const profilesToCheck = [];

for (const rawTag of hashtags) {
    if (totalSaved >= maxResults) break;
    const tag = rawTag.replace(/^#/, '').toLowerCase().trim();
    if (!tag) continue;

    log.info(`\n📌 Scraping #${tag}...`);
    let maxId = '';
    let pageNum = 0;

    while (pageNum < maxPagesPerHashtag) {
        pageNum++;

        let url = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
        if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;

        const data = await igFetch(url, sessionId, csrfToken, proxyUrl);

        if (!data) {
            log.warning(`#${tag} p${pageNum}: API returned nothing — skipping`);
            break;
        }

        const usernames = new Set();
        let nextMaxId = null;

        // Extract usernames from v1 API response
        nextMaxId = data?.data?.recent?.next_max_id || null;
        for (const key of ['recent', 'top']) {
            for (const section of (data?.data?.[key]?.sections || [])) {
                for (const m of [...(section?.layout_content?.medias || []), ...(section?.layout_content?.fill_media || [])]) {
                    const u = m?.media?.user || m?.media?.owner;
                    if (u?.username) usernames.add(u.username);
                }
            }
        }

        // Fallback: try GraphQL if v1 returned no users
        if (usernames.size === 0) {
            let gqlUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/?__a=1&__d=dis`;
            if (maxId) gqlUrl += `&max_id=${encodeURIComponent(maxId)}`;
            const gql = await igFetch(gqlUrl, sessionId, csrfToken, proxyUrl);
            if (gql) {
                const edges = gql?.graphql?.hashtag?.edge_hashtag_to_media?.edges || gql?.data?.hashtag?.edge_hashtag_to_media?.edges || [];
                for (const e of edges) {
                    if (e?.node?.owner?.username) usernames.add(e.node.owner.username);
                }
                nextMaxId = gql?.graphql?.hashtag?.edge_hashtag_to_media?.page_info?.end_cursor || null;
            }
        }

        log.info(`#${tag} p${pageNum}: ${usernames.size} users | next: ${nextMaxId ? '✅' : '❌'}`);

        for (const uname of usernames) {
            if (!seenUsers.has(uname)) {
                seenUsers.add(uname);
                profilesToCheck.push(uname);
            }
        }

        if (!nextMaxId) break;
        maxId = nextMaxId;

        // Small delay between pages to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
    }
}

log.info(`\n👥 Discovered ${profilesToCheck.length} unique users. Now checking profiles...\n`);

// ─── PHASE 2: Check each profile via Instagram API (pure HTTP) ───────────────

log.info(`📡 PHASE 2: Fetching profile data...`);

const externalLinksQueue = []; // collect {username, url} for Linktree/website scraping

for (const username of profilesToCheck) {
    if (totalSaved >= maxResults) break;

    const url  = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const data = await igFetch(url, sessionId, csrfToken, proxyUrl);
    const user = data?.data?.user;

    if (!user) {
        log.debug(`@${username}: no data`);
        continue;
    }

    const followerCount = user.edge_followed_by?.count ?? 0;
    if (followerCount < minFollowers) {
        log.debug(`@${username}: skipped — ${followerCount.toLocaleString()} followers`);
        continue;
    }

    const bio      = user.biography ?? '';
    const website  = user.external_url ?? '';
    const bioLinks = (user.bio_links ?? []).map(l => l.url).filter(Boolean);

    // All email sources from Instagram profile
    const businessEmail = user.business_email ?? '';   // Instagram "Email" button
    const publicEmail   = user.public_email ?? '';
    const emailsFromBio = extractEmails(bio);
    const emailsFromLinks = extractEmails([website, ...bioLinks].join(' '));
    const allEmails = mergeEmails(businessEmail, publicEmail, emailsFromBio, emailsFromLinks);

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
        emailsFromBio,
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

    // Queue external links for browser-based scraping
    for (const extUrl of [website, ...bioLinks].filter(u => u?.startsWith('http'))) {
        externalLinksQueue.push({ username: record.username, url: extUrl });
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
}

log.info(`\n✅ Phase 2 done. ${totalSaved} profiles saved.`);

// ─── PHASE 3: Scrape Linktree / websites for more emails (Playwright) ─────────

if (externalLinksQueue.length > 0) {
    log.info(`\n🔗 PHASE 3: Scraping ${externalLinksQueue.length} external links for emails...`);

    const extQueue = await RequestQueue.open('external-links');
    for (const { username, url } of externalLinksQueue) {
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
        maxConcurrency: 10,
        requestHandlerTimeoutSecs: 60,
        navigationTimeoutSecs: 30,
        maxRequestRetries: 1,

        launchContext: {
            launchOptions: {
                headless: true,
                args: ['--no-sandbox','--disable-setuid-sandbox'],
            },
        },

        async requestHandler({ request, page }) {
            const { username: uname, label } = { ...request.userData, label: request.label };
            log.info(`${label === 'LINKTREE' ? '🔗' : '🌐'} @${uname}: ${request.url}`);

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
                    log.info(`📧 @${uname}: found ${[...emails].join(', ')}`);
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
                            url,
                            label: 'WEBSITE',
                            userData: { username: uname },
                            uniqueKey: `ext:${uname}:${url}`,
                        }).catch(() => {});
                    }
                }
            } catch (e) {
                log.warning(`@${uname}: ${e.message}`);
            }
        },

        failedRequestHandler({ request, error }) {
            log.warning(`External link failed: ${request.url} — ${error.message}`);
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
    emailHitRate: `${hitRate}%`,
    scanned: seenUsers.size,
});

await Actor.exit();
