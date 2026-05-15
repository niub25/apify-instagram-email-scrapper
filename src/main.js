import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, RequestQueue, log } from 'crawlee';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractEmails(text) {
    if (!text) return [];
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const found = text.match(emailRegex) || [];
    return [...new Set(found.filter(e => !e.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)))];
}

// ─── Actor ────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput();
const {
    hashtags = ['running', 'marathon', 'halfmarathon', 'runningcommunity', 'runnersofinstagram'],
    minFollowers = 50000,
    maxResults = 200,
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;

if (!sessionId) {
    log.warning('No sessionId provided — Instagram will likely block requests.');
}

const seenUsers    = new Set();
const seenHashtags = new Set();
let   totalSaved   = 0;

const requestQueue = await RequestQueue.open();

for (const tag of hashtags) {
    const clean = tag.replace(/^#/, '').toLowerCase();
    if (seenHashtags.has(clean)) continue;
    seenHashtags.add(clean);
    await requestQueue.addRequest({
        url: `https://www.instagram.com/explore/tags/${encodeURIComponent(clean)}/`,
        label: 'HASHTAG',
        userData: { tag: clean },
    });
}

const proxy = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);

const crawler = new PlaywrightCrawler({
    requestQueue,
    proxyConfiguration: proxy,
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,

    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            if (sessionId) {
                await page.context().addCookies([
                    { name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
                    ...(csrfToken ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }] : []),
                ]);
            }
        },
    ],

    async requestHandler({ request, page }) {
        if (totalSaved >= maxResults) return;
        const { label, tag, username } = request.userData;

        // ── HASHTAG ───────────────────────────────────────────────────────────
        if (label === 'HASHTAG') {
            log.info(`Scraping hashtag: #${tag}`);
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

            const usernames = new Set();

            // Call Instagram's tag API from within the page (uses injected session cookies)
            try {
                const apiData = await page.evaluate(async (tagName) => {
                    const headers = {
                        'X-IG-App-ID': '936619743392459',
                        'X-ASBD-ID': '129477',
                        'Accept': '*/*',
                        'X-Requested-With': 'XMLHttpRequest',
                    };
                    // Try v1 API
                    let res = await fetch(
                        `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tagName)}`,
                        { headers, credentials: 'include' }
                    );
                    if (res.ok) return { source: 'v1', data: await res.json() };

                    // Fallback: try GraphQL API
                    res = await fetch(
                        `https://www.instagram.com/explore/tags/${encodeURIComponent(tagName)}/?__a=1&__d=dis`,
                        { headers, credentials: 'include' }
                    );
                    if (res.ok) return { source: 'graphql', data: await res.json() };

                    return null;
                }, tag);

                if (apiData?.data) {
                    const d = apiData.data;

                    if (apiData.source === 'v1') {
                        for (const section of [
                            ...(d?.data?.recent?.sections || []),
                            ...(d?.data?.top?.sections || []),
                        ]) {
                            const medias = [
                                ...(section?.layout_content?.medias || []),
                                ...(section?.layout_content?.fill_media || []),
                            ];
                            for (const m of medias) {
                                const u = m?.media?.user || m?.media?.owner;
                                if (u?.username) usernames.add(u.username);
                            }
                        }
                    }

                    if (apiData.source === 'graphql') {
                        const edges = d?.graphql?.hashtag?.edge_hashtag_to_media?.edges || 
                                      d?.data?.hashtag?.edge_hashtag_to_media?.edges || [];
                        for (const edge of edges) {
                            const owner = edge?.node?.owner;
                            if (owner?.username) usernames.add(owner.username);
                        }
                    }

                    log.info(`#${tag}: API returned ${usernames.size} users`);
                } else {
                    log.warning(`#${tag}: API returned no data`);
                }
            } catch (e) {
                log.warning(`#${tag}: API call failed — ${e.message}`);
            }

            // Fallback: scrape post links from the page DOM
            if (usernames.size === 0) {
                try {
                    const postLinks = await page.$$eval('a[href*="/p/"]', els =>
                        [...new Set(els.map(el => el.href))].slice(0, 40)
                    );
                    log.info(`#${tag}: fallback — found ${postLinks.length} post links in DOM`);

                    for (const postUrl of postLinks) {
                        await requestQueue.addRequest({
                            url: postUrl,
                            label: 'POST',
                            userData: { tag },
                            uniqueKey: `post:${postUrl}`,
                        });
                    }
                } catch {}
            }

            // Queue profiles
            for (const uname of usernames) {
                if (seenUsers.has(uname)) continue;
                seenUsers.add(uname);
                await requestQueue.addRequest({
                    url: `https://www.instagram.com/${uname}/`,
                    label: 'PROFILE',
                    userData: { username: uname },
                    uniqueKey: `profile:${uname}`,
                });
            }
            return;
        }

        // ── POST — extract username from post page ────────────────────────────
        if (label === 'POST') {
            try {
                await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
                const uname = await page.evaluate(() => {
                    const link = document.querySelector('header a[href^="/"], article a[href^="/"]');
                    if (!link) return null;
                    const m = link.getAttribute('href').match(/^\/([^/]+)\/?$/);
                    return m ? m[1] : null;
                });
                if (uname && !seenUsers.has(uname)) {
                    seenUsers.add(uname);
                    await requestQueue.addRequest({
                        url: `https://www.instagram.com/${uname}/`,
                        label: 'PROFILE',
                        userData: { username: uname },
                        uniqueKey: `profile:${uname}`,
                    });
                }
            } catch {}
            return;
        }

        // ── PROFILE ───────────────────────────────────────────────────────────
        if (label === 'PROFILE') {
            if (totalSaved >= maxResults) return;
            log.info(`Checking @${username}`);

            try {
                const profileData = await page.evaluate(async (uname) => {
                    const res = await fetch(
                        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`,
                        {
                            headers: { 'X-IG-App-ID': '936619743392459', 'X-ASBD-ID': '129477', 'Accept': '*/*' },
                            credentials: 'include',
                        }
                    );
                    if (!res.ok) return null;
                    return res.json();
                }, username);

                const user = profileData?.data?.user;
                if (!user) return;

                const followerCount = user.edge_followed_by?.count ?? 0;
                if (followerCount < minFollowers) {
                    log.debug(`@${username}: skipped — ${followerCount.toLocaleString()} followers`);
                    return;
                }

                const bio      = user.biography ?? '';
                const website  = user.external_url ?? '';
                const bioLinks = (user.bio_links ?? []).map(l => l.url).join(' ');
                const emails   = extractEmails([bio, website, bioLinks].join(' '));

                await Dataset.pushData({
                    username: user.username ?? username,
                    fullName: user.full_name ?? '',
                    profileUrl: `https://www.instagram.com/${username}/`,
                    followers: followerCount,
                    following: user.edge_follow?.count ?? 0,
                    posts: user.edge_owner_to_timeline_media?.count ?? 0,
                    bio,
                    website,
                    bioLinks,
                    emails,
                    hasEmail: emails.length > 0,
                    isVerified: user.is_verified ?? false,
                    isPrivate: user.is_private ?? false,
                    profilePicUrl: user.profile_pic_url_hd ?? user.profile_pic_url ?? '',
                    scrapedAt: new Date().toISOString(),
                });

                totalSaved++;
                log.info(`✅ @${username} | ${followerCount.toLocaleString()} followers | Emails: ${emails.length ? emails.join(', ') : '—'} [${totalSaved}/${maxResults}]`);

                if (totalSaved >= maxResults) {
                    log.info('Reached maxResults. Stopping.');
                    await Actor.exit();
                }
            } catch (e) {
                log.warning(`@${username}: error — ${e.message}`);
            }
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} — ${error.message}`);
    },
});

log.info(`🏃 Starting | Hashtags: ${hashtags.join(', ')} | Min followers: ${minFollowers.toLocaleString()} | Max: ${maxResults}`);
await crawler.run();

const dataset = await Dataset.open();
const { items } = await dataset.getData();
const withEmail = items.filter(i => i.hasEmail).length;
log.info(`🎉 Done! Saved: ${totalSaved} | With email: ${withEmail} | Scanned: ${seenUsers.size}`);
await Actor.setValue('SUMMARY', { totalSaved, withEmail, uniqueUsersScanned: seenUsers.size });
await Actor.exit();
