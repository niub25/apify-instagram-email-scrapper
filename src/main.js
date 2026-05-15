import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, RequestQueue, log } from 'crawlee';

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
    return [
        'linktr.ee', 'bio.link', 'beacons.ai', 'solo.to',
        'campsite.bio', 'koji.to', 'taplink.cc', 'allmylinks.com',
        'lnk.bio', 'msha.ke', 'carrd.co', 'about.me',
        'bento.me', 'milkshake.app', 'linkin.bio',
    ].some(a => url.includes(a));
}

// ─── Actor ────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput();
const {
    hashtags = [
        'running', 'marathon', 'halfmarathon', 'runningcommunity',
        'runnersofinstagram', 'ultramarathon', 'trailrunning',
        'runnerlife', 'runningmotivation', 'roadrunning',
        'marathontraining', 'runningcoach', 'runningwomen',
        'instarunners', 'runner', 'runhappy', 'marathonrunner',
        'halfmarathontraining', 'runningdaily', 'trailrunner',
        'runninglifestyle', 'morningrun', 'runningislife',
        'marathoners', 'runningworld', 'bostonmarathon',
        'runforlife', 'runningmen', 'hyrox', 'runcoach',
    ],
    minFollowers = 5000,
    maxResults = 500,
    maxPagesPerHashtag = 10,    // how many paginated pages to fetch per hashtag (~20 users each)
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;

if (!sessionId) log.warning('No sessionId — Instagram will rate-limit heavily.');

// ─── State ────────────────────────────────────────────────────────────────────
const seenUsers    = new Set();
const seenHashtags = new Set();
const savedData    = new Map();
let   totalSaved   = 0;

const requestQueue = await RequestQueue.open();

// We use ONE persistent browser page for all Instagram API calls
// and separate pages for external sites (Linktree, websites)
// Seed: one request per hashtag → the handler will paginate internally
for (const tag of hashtags) {
    const clean = tag.replace(/^#/, '').toLowerCase().trim();
    if (!clean || seenHashtags.has(clean)) continue;
    seenHashtags.add(clean);
    await requestQueue.addRequest({
        url: `https://www.instagram.com/explore/tags/${encodeURIComponent(clean)}/`,
        label: 'HASHTAG',
        userData: { tag: clean, pageNum: 1, maxId: '' },
    });
}

const proxy = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);

// ─── Crawler ──────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    requestQueue,
    proxyConfiguration: proxy,
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 30,
    maxRequestRetries: 2,

    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
        },
    },

    preNavigationHooks: [
        async ({ page, request }) => {
            if (request.url.includes('instagram.com') && sessionId) {
                await page.context().addCookies([
                    { name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
                    ...(csrfToken ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }] : []),
                ]);
            }
        },
    ],

    async requestHandler({ request, page }) {
        const { label, tag, username, pageNum, maxId } = request.userData;

        // ─────────────────────────────────────────────────────────────────────
        // HASHTAG — fetch one page of results, then queue next page
        // ─────────────────────────────────────────────────────────────────────
        if (label === 'HASHTAG') {
            log.info(`📌 #${tag} — page ${pageNum}${maxId ? ` (cursor: ${maxId.slice(0,12)}...)` : ''}`);

            // Wait for page load only on first page (subsequent pages use API directly)
            if (pageNum === 1) {
                await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
            }

            // ── Call Instagram's hashtag API from inside the authenticated browser ──
            const apiResult = await page.evaluate(async ({ tagName, cursor }) => {
                const headers = {
                    'X-IG-App-ID': '936619743392459',
                    'X-ASBD-ID': '129477',
                    'Accept': '*/*',
                    'X-Requested-With': 'XMLHttpRequest',
                };

                const usernames = [];
                let nextMaxId   = null;

                // ── v1 API (primary) ──────────────────────────────────────────
                try {
                    let url = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tagName)}`;
                    if (cursor) url += `&max_id=${encodeURIComponent(cursor)}`;

                    const r = await fetch(url, { headers, credentials: 'include' });
                    if (r.ok) {
                        const d = await r.json();

                        // Extract next page cursor
                        nextMaxId = d?.data?.recent?.next_max_id || null;

                        // Extract usernames from both recent + top sections
                        for (const key of ['recent', 'top']) {
                            for (const section of (d?.data?.[key]?.sections || [])) {
                                const medias = [
                                    ...(section?.layout_content?.medias || []),
                                    ...(section?.layout_content?.fill_media || []),
                                ];
                                for (const m of medias) {
                                    const u = m?.media?.user || m?.media?.owner;
                                    if (u?.username) usernames.push(u.username);
                                }
                            }
                        }
                    }
                } catch {}

                // ── GraphQL API (fallback if v1 returns nothing) ──────────────
                if (usernames.length === 0) {
                    try {
                        let url = `https://www.instagram.com/explore/tags/${encodeURIComponent(tagName)}/?__a=1&__d=dis`;
                        if (cursor) url += `&max_id=${encodeURIComponent(cursor)}`;

                        const r2 = await fetch(url, { headers, credentials: 'include' });
                        if (r2.ok) {
                            const d2 = await r2.json();
                            const edges =
                                d2?.graphql?.hashtag?.edge_hashtag_to_media?.edges ||
                                d2?.data?.hashtag?.edge_hashtag_to_media?.edges || [];
                            for (const e of edges) {
                                if (e?.node?.owner?.username) usernames.push(e.node.owner.username);
                            }
                            nextMaxId = d2?.graphql?.hashtag?.edge_hashtag_to_media?.page_info?.end_cursor
                                     || d2?.data?.hashtag?.edge_hashtag_to_media?.page_info?.end_cursor
                                     || null;
                        }
                    } catch {}
                }

                return { usernames: [...new Set(usernames)], nextMaxId };
            }, { tagName: tag, cursor: maxId });

            const { usernames, nextMaxId } = apiResult;
            log.info(`#${tag} page ${pageNum}: found ${usernames.length} users | next cursor: ${nextMaxId ? '✅' : '❌ (last page)'}`);

            // Queue profile checks for new users
            let queued = 0;
            for (const uname of usernames) {
                if (seenUsers.has(uname) || totalSaved + queued >= maxResults * 3) continue;
                seenUsers.add(uname);
                await requestQueue.addRequest({
                    url: `https://www.instagram.com/${uname}/`,
                    label: 'PROFILE',
                    userData: { username: uname },
                    uniqueKey: `profile:${uname}`,
                }).catch(() => {});
                queued++;
            }
            log.info(`#${tag} page ${pageNum}: queued ${queued} new profiles`);

            // ── Paginate: queue next page if cursor available and within limit ──
            if (nextMaxId && pageNum < maxPagesPerHashtag && totalSaved < maxResults) {
                await requestQueue.addRequest({
                    url: `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`,
                    label: 'HASHTAG',
                    userData: { tag, pageNum: pageNum + 1, maxId: nextMaxId },
                    uniqueKey: `hashtag:${tag}:page:${pageNum + 1}`,
                });
                log.info(`#${tag}: queued page ${pageNum + 1}`);
            } else if (!nextMaxId) {
                log.info(`#${tag}: reached last page (${pageNum} pages total)`);
            }
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // PROFILE — fetch user data via API (NO page navigation, avoids redirects)
        // ─────────────────────────────────────────────────────────────────────
        if (label === 'PROFILE') {
            if (totalSaved >= maxResults) return;
            log.info(`👤 Checking @${username}`);

            // Navigate to instagram.com home (not profile page) to avoid redirect loops
            // Then call the profile API via fetch using the session cookie
            try {
                const currentUrl = page.url();
                if (!currentUrl.includes('instagram.com') || currentUrl.includes('/explore/')) {
                    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                }
            } catch {}

            let user = null;
            try {
                const profileData = await page.evaluate(async (uname) => {
                    const r = await fetch(
                        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`,
                        {
                            headers: {
                                'X-IG-App-ID': '936619743392459',
                                'X-ASBD-ID': '129477',
                                'Accept': '*/*',
                            },
                            credentials: 'include',
                        }
                    );
                    if (!r.ok) return null;
                    return r.json();
                }, username);
                user = profileData?.data?.user;
            } catch (e) {
                log.warning(`@${username}: profile API error — ${e.message}`);
                return;
            }

            if (!user) { log.debug(`@${username}: no data`); return; }

            const followerCount = user.edge_followed_by?.count ?? 0;
            if (followerCount < minFollowers) {
                log.debug(`@${username}: skipped — ${followerCount.toLocaleString()} followers`);
                return;
            }

            const bio      = user.biography ?? '';
            const website  = user.external_url ?? '';
            const bioLinks = (user.bio_links ?? []).map(l => l.url).filter(Boolean);

            // ── All email sources from Instagram profile data ─────────────────
            const businessEmail = user.business_email ?? '';   // Instagram "Email" button
            const publicEmail   = user.public_email ?? '';     // Instagram public email field

            const emailsFromBio   = extractEmails(bio);
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

            log.info(
                `✅ @${record.username} | ${followerCount.toLocaleString()} followers | ` +
                `Emails: ${allEmails.length ? allEmails.join(', ') : '—'} [${totalSaved}/${maxResults}]`
            );

            // Queue external links for Linktree/website email scraping
            const linksToVisit = [website, ...bioLinks].filter(Boolean);
            for (const extUrl of linksToVisit) {
                if (!extUrl.startsWith('http')) continue;
                await requestQueue.addRequest({
                    url: extUrl,
                    label: isLinkAggregator(extUrl) ? 'LINKTREE' : 'WEBSITE',
                    userData: { username: record.username },
                    uniqueKey: `ext:${record.username}:${extUrl}`,
                }).catch(() => {});
            }

            if (totalSaved >= maxResults) {
                log.info('Reached maxResults. Stopping.');
                await Actor.exit();
            }
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // LINKTREE — scrape link aggregator for emails
        // ─────────────────────────────────────────────────────────────────────
        if (label === 'LINKTREE') {
            const { username: uname } = request.userData;
            log.info(`🔗 Linktree @${uname}: ${request.url}`);

            try {
                await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

                const { text, hrefs } = await page.evaluate(() => ({
                    text:  document.body?.innerText ?? '',
                    hrefs: [...document.querySelectorAll('a[href]')].map(a => a.href),
                }));

                const emails = new Set();
                for (const e of extractEmails(text)) emails.add(e);
                for (const href of hrefs) {
                    if (href.startsWith('mailto:')) emails.add(href.replace('mailto:', '').split('?')[0].trim());
                }
                for (const e of extractEmails(hrefs.join(' '))) emails.add(e);

                if (emails.size > 0) {
                    log.info(`📧 @${uname} Linktree: ${[...emails].join(', ')}`);
                    await updateRecord(uname, [...emails]);
                }

                // Follow outbound links (personal sites)
                const outbound = await page.$$eval('a[href^="http"]', els =>
                    els.map(a => a.href).filter(h =>
                        !['instagram.com','linktree','facebook.com','twitter.com',
                          'x.com','tiktok.com','youtube.com','spotify.com','apple.com','google.com']
                        .some(d => h.includes(d))
                    ).slice(0, 4)
                ).catch(() => []);

                for (const url of outbound) {
                    await requestQueue.addRequest({
                        url,
                        label: 'WEBSITE',
                        userData: { username: uname },
                        uniqueKey: `ext:${uname}:${url}`,
                    }).catch(() => {});
                }
            } catch (e) {
                log.warning(`@${uname}: Linktree error — ${e.message}`);
            }
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // WEBSITE — scrape personal website for emails
        // ─────────────────────────────────────────────────────────────────────
        if (label === 'WEBSITE') {
            const { username: uname } = request.userData;
            log.info(`🌐 Website @${uname}: ${request.url}`);

            try {
                await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});

                const { text, hrefs } = await page.evaluate(() => ({
                    text:  document.body?.innerText ?? '',
                    hrefs: [...document.querySelectorAll('a[href^="mailto:"]')].map(a => a.href),
                }));

                const emails = new Set();
                for (const e of extractEmails(text)) emails.add(e);
                for (const href of hrefs) emails.add(href.replace('mailto:', '').split('?')[0].trim());

                if (emails.size > 0) {
                    log.info(`📧 @${uname} website: ${[...emails].join(', ')}`);
                    await updateRecord(uname, [...emails]);
                }
            } catch (e) {
                log.warning(`@${uname}: website error — ${e.message}`);
            }
            return;
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} — ${error.message}`);
    },
});

// ─── Update saved record with new emails ─────────────────────────────────────

async function updateRecord(username, newEmails) {
    const existing = savedData.get(username);
    if (!existing) return;
    const merged = mergeEmails(existing.emails, newEmails);
    if (merged.length === existing.emails.length) return;
    existing.emails   = merged;
    existing.hasEmail = true;
    await Dataset.pushData({ ...existing, _updated: true });
    savedData.set(username, existing);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

log.info(
    `🏃 Instagram Email Scraper v5\n` +
    `   Hashtags        : ${hashtags.length} tags\n` +
    `   Pages/hashtag   : ${maxPagesPerHashtag} (~${maxPagesPerHashtag * 20} users each)\n` +
    `   Min followers   : ${minFollowers.toLocaleString()}\n` +
    `   Max results     : ${maxResults}`
);

await crawler.run();

// ─── Summary ──────────────────────────────────────────────────────────────────

const { items } = await (await Dataset.open()).getData();
const unique = new Map();
for (const item of items) {
    if (!unique.has(item.username) || item._updated) unique.set(item.username, item);
}
const final      = [...unique.values()];
const withEmail  = final.filter(i => i.hasEmail).length;
const hitRate    = final.length ? Math.round(withEmail / final.length * 100) : 0;

log.info(`\n🎉 Done!`);
log.info(`   Profiles saved  : ${final.length}`);
log.info(`   With email      : ${withEmail} (${hitRate}%)`);
log.info(`   Users scanned   : ${seenUsers.size}`);

await Actor.setValue('SUMMARY', { profilesSaved: final.length, withEmail, emailHitRate: `${hitRate}%`, scanned: seenUsers.size });
await Actor.exit();
