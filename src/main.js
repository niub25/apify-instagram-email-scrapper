import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, RequestQueue, log } from 'crawlee';

// ─── Email extraction ─────────────────────────────────────────────────────────

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

// ─── Detect link aggregator pages ────────────────────────────────────────────

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
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;

if (!sessionId) log.warning('No sessionId provided — Instagram will rate-limit heavily.');

// ─── Shared state ─────────────────────────────────────────────────────────────
const seenUsers    = new Set();
const seenHashtags = new Set();
const savedData    = new Map();   // username → record (updated when emails found on external pages)
let   totalSaved   = 0;

const requestQueue = await RequestQueue.open();

// Seed hashtag pages
for (const tag of hashtags) {
    const clean = tag.replace(/^#/, '').toLowerCase().trim();
    if (!clean || seenHashtags.has(clean)) continue;
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

// ─── Crawler ──────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    requestQueue,
    proxyConfiguration: proxy,
    maxConcurrency: 5,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 45,
    maxRequestRetries: 2,

    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
            ],
        },
    },

    preNavigationHooks: [
        async ({ page, request }) => {
            if (request.url.includes('instagram.com') && sessionId) {
                await page.context().addCookies([
                    {
                        name: 'sessionid',
                        value: sessionId,
                        domain: '.instagram.com',
                        path: '/',
                        httpOnly: true,
                        secure: true,
                    },
                    ...(csrfToken ? [{
                        name: 'csrftoken',
                        value: csrfToken,
                        domain: '.instagram.com',
                        path: '/',
                        secure: true,
                    }] : []),
                ]);
            }
        },
    ],

    async requestHandler({ request, page }) {
        const { label, tag, username } = request.userData;

        // ────────────────────────────────────────────────────────────────────
        // HASHTAG — discover users from a hashtag page
        // ────────────────────────────────────────────────────────────────────
        if (label === 'HASHTAG') {
            log.info(`📌 Scraping hashtag: #${tag}`);
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

            const usernames = new Set();

            // Call Instagram's internal API from within the authenticated browser session
            try {
                const results = await page.evaluate(async (tagName) => {
                    const headers = {
                        'X-IG-App-ID': '936619743392459',
                        'X-ASBD-ID': '129477',
                        'Accept': '*/*',
                        'X-Requested-With': 'XMLHttpRequest',
                    };
                    const found = new Set();

                    // Method 1: v1 tags API
                    try {
                        const r = await fetch(
                            `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tagName)}`,
                            { headers, credentials: 'include' }
                        );
                        if (r.ok) {
                            const d = await r.json();
                            for (const key of ['recent', 'top']) {
                                for (const section of (d?.data?.[key]?.sections || [])) {
                                    const medias = [
                                        ...(section?.layout_content?.medias || []),
                                        ...(section?.layout_content?.fill_media || []),
                                    ];
                                    for (const m of medias) {
                                        const u = m?.media?.user || m?.media?.owner;
                                        if (u?.username) found.add(u.username);
                                    }
                                }
                            }
                        }
                    } catch {}

                    // Method 2: GraphQL hashtag API
                    try {
                        const r2 = await fetch(
                            `https://www.instagram.com/explore/tags/${encodeURIComponent(tagName)}/?__a=1&__d=dis`,
                            { headers, credentials: 'include' }
                        );
                        if (r2.ok) {
                            const d2 = await r2.json();
                            const edges =
                                d2?.graphql?.hashtag?.edge_hashtag_to_media?.edges ||
                                d2?.data?.hashtag?.edge_hashtag_to_media?.edges ||
                                [];
                            for (const e of edges) {
                                if (e?.node?.owner?.username) found.add(e.node.owner.username);
                            }
                        }
                    } catch {}

                    return [...found];
                }, tag);

                for (const u of results) usernames.add(u);
                log.info(`#${tag}: API found ${usernames.size} users`);
            } catch (e) {
                log.warning(`#${tag}: API error — ${e.message}`);
            }

            // Fallback: extract from DOM post links if API returned nothing
            if (usernames.size === 0) {
                try {
                    const links = await page.$$eval('a[href*="/p/"]', els =>
                        [...new Set(els.map(el => el.href).filter(Boolean))].slice(0, 50)
                    );
                    log.info(`#${tag}: DOM fallback — ${links.length} post links`);
                    for (const postUrl of links) {
                        await requestQueue.addRequest({
                            url: postUrl,
                            label: 'POST',
                            userData: { tag },
                            uniqueKey: `post:${postUrl}`,
                        }).catch(() => {});
                    }
                } catch {}
            }

            // Queue profile pages for all discovered users
            let queued = 0;
            for (const uname of usernames) {
                if (seenUsers.has(uname)) continue;
                seenUsers.add(uname);
                await requestQueue.addRequest({
                    url: `https://www.instagram.com/${uname}/`,
                    label: 'PROFILE',
                    userData: { username: uname },
                    uniqueKey: `profile:${uname}`,
                }).catch(() => {});
                queued++;
            }
            log.info(`#${tag}: queued ${queued} new profiles`);
            return;
        }

        // ────────────────────────────────────────────────────────────────────
        // POST — extract username from a post page (fallback)
        // ────────────────────────────────────────────────────────────────────
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
                    }).catch(() => {});
                }
            } catch {}
            return;
        }

        // ────────────────────────────────────────────────────────────────────
        // PROFILE — fetch user data + all email sources
        // ────────────────────────────────────────────────────────────────────
        if (label === 'PROFILE') {
            if (totalSaved >= maxResults) return;
            log.info(`👤 Checking @${username}`);

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
            } catch {}

            if (!user) {
                log.debug(`@${username}: no data returned`);
                return;
            }

            // ── Follower filter ───────────────────────────────────────────────
            const followerCount = user.edge_followed_by?.count ?? 0;
            if (followerCount < minFollowers) {
                log.debug(`@${username}: skipped — ${followerCount.toLocaleString()} followers`);
                return;
            }

            // ── All profile fields ────────────────────────────────────────────
            const bio      = user.biography ?? '';
            const website  = user.external_url ?? '';
            const bioLinks = (user.bio_links ?? []).map(l => l.url).filter(Boolean);

            // ── EMAIL SOURCE 1: Instagram native Email button ─────────────────
            // This is the email set in Instagram's business/creator contact info
            // (shows as the "Email" button on the profile)
            const businessEmail = user.business_email ?? '';
            const publicEmail   = user.public_email ?? '';

            // ── EMAIL SOURCE 2: Bio text (plain email in bio) ─────────────────
            const emailsFromBioText = extractEmails(bio);

            // ── EMAIL SOURCE 3: Website / bio links (plain email in URL) ──────
            const emailsFromLinks = extractEmails([website, ...bioLinks].join(' '));

            // Merge all immediately available emails
            const allEmails = mergeEmails(
                businessEmail,
                publicEmail,
                emailsFromBioText,
                emailsFromLinks,
            );

            const record = {
                username:       user.username ?? username,
                fullName:       user.full_name ?? '',
                profileUrl:     `https://www.instagram.com/${username}/`,
                followers:      followerCount,
                following:      user.edge_follow?.count ?? 0,
                posts:          user.edge_owner_to_timeline_media?.count ?? 0,
                bio,
                website,
                bioLinks:       bioLinks.join(', '),

                // Email fields
                businessEmail,                          // Instagram Email button
                publicEmail,                            // Instagram public email field
                emailsFromBio:  emailsFromBioText,      // Emails found in bio text
                emails:         allEmails,              // All emails combined
                hasEmail:       allEmails.length > 0,

                // Profile metadata
                isVerified:     user.is_verified ?? false,
                isPrivate:      user.is_private ?? false,
                isBusinessAccount: user.is_business_account ?? false,
                businessCategory:  user.business_category_name ?? '',
                profilePicUrl:  user.profile_pic_url_hd ?? user.profile_pic_url ?? '',
                scrapedAt:      new Date().toISOString(),
            };

            await Dataset.pushData(record);
            savedData.set(record.username, record);
            totalSaved++;

            const emailDisplay = allEmails.length ? allEmails.join(', ') : '—';
            log.info(
                `✅ @${record.username} | ${followerCount.toLocaleString()} followers | ` +
                `Emails: ${emailDisplay} [${totalSaved}/${maxResults}]`
            );

            // ── Queue external links for deeper email scraping ────────────────
            const linksToVisit = [];
            if (website) linksToVisit.push(website);
            for (const link of bioLinks) {
                if (link && link !== website) linksToVisit.push(link);
            }

            for (const extUrl of linksToVisit) {
                if (!extUrl || !extUrl.startsWith('http')) continue;
                const linkLabel = isLinkAggregator(extUrl) ? 'LINKTREE' : 'WEBSITE';
                await requestQueue.addRequest({
                    url: extUrl,
                    label: linkLabel,
                    userData: { username: record.username, sourceUrl: extUrl },
                    uniqueKey: `ext:${record.username}:${extUrl}`,
                }).catch(() => {});
            }

            if (totalSaved >= maxResults) {
                log.info(`Reached maxResults (${maxResults}). Wrapping up.`);
                await Actor.exit();
            }
            return;
        }

        // ────────────────────────────────────────────────────────────────────
        // LINKTREE — scrape Linktree and other link aggregator pages
        // ────────────────────────────────────────────────────────────────────
        if (label === 'LINKTREE') {
            const { username: uname } = request.userData;
            log.info(`🔗 Linktree for @${uname}: ${request.url}`);

            try {
                await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

                const pageData = await page.evaluate(() => {
                    const text  = document.body?.innerText ?? '';
                    const hrefs = [...document.querySelectorAll('a[href]')].map(a => a.href);
                    return { text, hrefs };
                });

                const emails = new Set();

                // From visible page text
                for (const e of extractEmails(pageData.text)) emails.add(e);

                // From mailto: links
                for (const href of pageData.hrefs) {
                    if (href.startsWith('mailto:')) {
                        emails.add(href.replace('mailto:', '').split('?')[0].trim());
                    }
                }

                // From email addresses embedded in any URL
                for (const e of extractEmails(pageData.hrefs.join(' '))) emails.add(e);

                if (emails.size > 0) {
                    log.info(`📧 @${uname}: ${emails.size} email(s) on Linktree — ${[...emails].join(', ')}`);
                    await updateRecord(uname, [...emails]);
                } else {
                    log.debug(`@${uname}: no emails on Linktree`);
                }

                // Follow outbound links from Linktree (personal sites, booking pages etc.)
                const outbound = await page.$$eval('a[href^="http"]', els =>
                    els.map(a => a.href).filter(h =>
                        !h.includes('instagram.com') &&
                        !h.includes('linktree') &&
                        !h.includes('facebook.com') &&
                        !h.includes('twitter.com') &&
                        !h.includes('x.com') &&
                        !h.includes('tiktok.com') &&
                        !h.includes('youtube.com') &&
                        !h.includes('spotify.com') &&
                        !h.includes('apple.com') &&
                        !h.includes('google.com')
                    ).slice(0, 4)
                ).catch(() => []);

                for (const outUrl of outbound) {
                    await requestQueue.addRequest({
                        url: outUrl,
                        label: 'WEBSITE',
                        userData: { username: uname, sourceUrl: outUrl },
                        uniqueKey: `ext:${uname}:${outUrl}`,
                    }).catch(() => {});
                }
            } catch (e) {
                log.warning(`@${uname}: Linktree error — ${e.message}`);
            }
            return;
        }

        // ────────────────────────────────────────────────────────────────────
        // WEBSITE — scrape personal website / blog for email
        // ────────────────────────────────────────────────────────────────────
        if (label === 'WEBSITE') {
            const { username: uname } = request.userData;
            log.info(`🌐 Website for @${uname}: ${request.url}`);

            try {
                await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});

                const pageData = await page.evaluate(() => {
                    const text  = document.body?.innerText ?? '';
                    const hrefs = [...document.querySelectorAll('a[href^="mailto:"]')].map(a => a.href);
                    return { text, hrefs };
                });

                const emails = new Set();

                for (const e of extractEmails(pageData.text)) emails.add(e);
                for (const href of pageData.hrefs) {
                    emails.add(href.replace('mailto:', '').split('?')[0].trim());
                }

                if (emails.size > 0) {
                    log.info(`📧 @${uname}: ${emails.size} email(s) on website — ${[...emails].join(', ')}`);
                    await updateRecord(uname, [...emails]);
                } else {
                    log.debug(`@${uname}: no emails on website`);
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

// ─── Helper: merge newly found emails into saved record ───────────────────────

async function updateRecord(username, newEmails) {
    const existing = savedData.get(username);
    if (!existing) return;
    const merged = mergeEmails(existing.emails, newEmails);
    if (merged.length === existing.emails.length) return; // nothing new
    existing.emails  = merged;
    existing.hasEmail = true;
    await Dataset.pushData({ ...existing, _updated: true });
    savedData.set(username, existing);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

log.info(
    `🏃 Starting Instagram Email Scraper v4\n` +
    `   Hashtags     : ${hashtags.join(', ')}\n` +
    `   Min followers: ${minFollowers.toLocaleString()}\n` +
    `   Max results  : ${maxResults}`
);

await crawler.run();

// ─── Final summary ────────────────────────────────────────────────────────────

const dataset = await Dataset.open();
const { items } = await dataset.getData();

// De-duplicate (profiles saved twice when emails updated)
const unique = new Map();
for (const item of items) {
    const prev = unique.get(item.username);
    if (!prev || item._updated) unique.set(item.username, item);
}
const finalItems = [...unique.values()];
const withEmail  = finalItems.filter(i => i.hasEmail).length;
const hitRate    = finalItems.length ? Math.round(withEmail / finalItems.length * 100) : 0;

log.info(`\n🎉 Done!`);
log.info(`   Profiles saved  : ${finalItems.length}`);
log.info(`   With email      : ${withEmail}`);
log.info(`   Email hit rate  : ${hitRate}%`);
log.info(`   Users scanned   : ${seenUsers.size}`);

await Actor.setValue('SUMMARY', {
    profilesSaved: finalItems.length,
    withEmail,
    emailHitRate: `${hitRate}%`,
    uniqueUsersScanned: seenUsers.size,
});

await Actor.exit();
