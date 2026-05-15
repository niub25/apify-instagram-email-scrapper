import { Actor } from 'apify';
import { CheerioCrawler, RequestQueue, Dataset, log } from 'crawlee';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract all email addresses from a string */
function extractEmails(text) {
    if (!text) return [];
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const found = text.match(emailRegex) || [];
    // Filter out common false-positives (image file names, etc.)
    return [...new Set(found.filter(e => !e.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)))];
}

/** Parse Instagram follower count strings like "1.2M", "56.3K", "234" */
function parseFollowerCount(str) {
    if (!str) return 0;
    const clean = str.replace(/,/g, '').trim().toUpperCase();
    if (clean.endsWith('M')) return parseFloat(clean) * 1_000_000;
    if (clean.endsWith('K')) return parseFloat(clean) * 1_000;
    return parseInt(clean, 10) || 0;
}

/** Build Instagram hashtag API URL */
function hashtagUrl(tag, maxId = '') {
    const base = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
    return maxId ? `${base}&max_id=${maxId}` : base;
}

/** Build Instagram user profile API URL */
function profileApiUrl(username) {
    return `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
}

// ─── Actor ───────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput();
const {
    hashtags = ['running', 'marathon', 'halfmarathon', 'runningcommunity', 'runnersofinstagram'],
    minFollowers = 50000,
    maxResults = 200,
    sessionId,           // Instagram sessionid cookie (strongly recommended)
    csrfToken,           // Instagram csrftoken cookie (optional but helps)
    proxyConfiguration,
} = input;

if (!sessionId) {
    log.warning(
        'No Instagram sessionId provided. Requests may be heavily rate-limited. ' +
        'Provide your Instagram "sessionid" cookie value in the actor input for best results.'
    );
}

// ─── State ────────────────────────────────────────────────────────────────────
const seenUsers     = new Set();   // usernames already queued / processed
const seenHashtags  = new Set();   // hashtag pages already queued
let   totalSaved    = 0;

const requestQueue = await RequestQueue.open();

// ─── Seed: hashtag discovery pages ───────────────────────────────────────────
for (const tag of hashtags) {
    const cleanTag = tag.replace(/^#/, '').toLowerCase();
    if (seenHashtags.has(cleanTag)) continue;
    seenHashtags.add(cleanTag);
    await requestQueue.addRequest({
        url: hashtagUrl(cleanTag),
        label: 'HASHTAG',
        userData: { tag: cleanTag, maxId: '' },
    });
}

// ─── Proxy setup ─────────────────────────────────────────────────────────────
const proxy = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);

// ─── Shared headers (mimic Instagram web app) ────────────────────────────────
function instagramHeaders(referer = 'https://www.instagram.com/') {
    const headers = {
        'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-IG-App-ID': '936619743392459',
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'Referer': referer,
        'Origin': 'https://www.instagram.com',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
    };
    if (sessionId) {
        let cookie = `sessionid=${sessionId}`;
        if (csrfToken) cookie += `; csrftoken=${csrfToken}`;
        headers['Cookie'] = cookie;
        if (csrfToken) headers['X-CSRFToken'] = csrfToken;
    }
    return headers;
}

// ─── Crawler ──────────────────────────────────────────────────────────────────
const crawler = new CheerioCrawler({
    requestQueue,
    proxyConfiguration: proxy,
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 3,

    // Attach Instagram headers to every request
    preNavigationHooks: [
        async ({ request, session }, gotOptions) => {
            const referer =
                request.label === 'PROFILE'
                    ? `https://www.instagram.com/${request.userData.username}/`
                    : `https://www.instagram.com/explore/tags/${request.userData.tag}/`;

            gotOptions.headers = {
                ...gotOptions.headers,
                ...instagramHeaders(referer),
            };
        },
    ],

    async requestHandler({ request, body, json }) {
        if (totalSaved >= maxResults) return;

        // ── HASHTAG page ──────────────────────────────────────────────────────
        if (request.label === 'HASHTAG') {
            let data;
            try {
                data = typeof json === 'object' ? json : JSON.parse(body.toString());
            } catch {
                log.warning(`Could not parse hashtag response for #${request.userData.tag}`);
                return;
            }

            const tag = request.userData.tag;
            const sections = data?.data?.recent?.sections ?? [];
            const nextMaxId = data?.data?.recent?.next_max_id;

            // Collect unique usernames from posts in this page
            const usernames = new Set();
            for (const section of sections) {
                for (const layout of section.layout_content?.medias ?? []) {
                    const owner = layout?.media?.user;
                    if (owner?.username) usernames.add(owner.username);
                }
            }

            log.info(`#${tag}: found ${usernames.size} users on this page`);

            for (const username of usernames) {
                if (seenUsers.has(username) || totalSaved >= maxResults) continue;
                seenUsers.add(username);
                await requestQueue.addRequest({
                    url: profileApiUrl(username),
                    label: 'PROFILE',
                    userData: { username },
                });
            }

            // Paginate to next page if we still need more users
            if (nextMaxId && totalSaved < maxResults && seenUsers.size < maxResults * 3) {
                await requestQueue.addRequest({
                    url: hashtagUrl(tag, nextMaxId),
                    label: 'HASHTAG',
                    userData: { tag, maxId: nextMaxId },
                    uniqueKey: `${tag}__${nextMaxId}`,
                });
            }
            return;
        }

        // ── PROFILE page ──────────────────────────────────────────────────────
        if (request.label === 'PROFILE') {
            let data;
            try {
                data = typeof json === 'object' ? json : JSON.parse(body.toString());
            } catch {
                log.warning(`Could not parse profile for @${request.userData.username}`);
                return;
            }

            const user = data?.data?.user;
            if (!user) return;

            const followerCount  = user.edge_followed_by?.count ?? 0;
            const followingCount = user.edge_follow?.count ?? 0;
            const username       = user.username ?? request.userData.username;
            const fullName       = user.full_name ?? '';
            const bio            = user.biography ?? '';
            const bioLinks       = user.bio_links?.map(l => l.url).join(' ') ?? '';
            const website        = user.external_url ?? '';
            const isVerified     = user.is_verified ?? false;
            const isPrivate      = user.is_private ?? false;
            const postsCount     = user.edge_owner_to_timeline_media?.count ?? 0;
            const profilePicUrl  = user.profile_pic_url_hd ?? user.profile_pic_url ?? '';

            // ── Follower filter ───────────────────────────────────────────────
            if (followerCount < minFollowers) {
                log.debug(`@${username} skipped — only ${followerCount.toLocaleString()} followers`);
                return;
            }

            // ── Email extraction ──────────────────────────────────────────────
            const emailSources  = [bio, website, bioLinks].join(' ');
            const emails        = extractEmails(emailSources);

            const record = {
                username,
                fullName,
                profileUrl:   `https://www.instagram.com/${username}/`,
                followers:    followerCount,
                following:    followingCount,
                posts:        postsCount,
                bio,
                website,
                bioLinks,
                isVerified,
                isPrivate,
                emails,                         // extracted emails array
                hasEmail:     emails.length > 0,
                profilePicUrl,
                scrapedAt:    new Date().toISOString(),
            };

            await Dataset.pushData(record);
            totalSaved++;

            const emailStr = emails.length ? emails.join(', ') : '—';
            log.info(
                `✅ @${username} | ${followerCount.toLocaleString()} followers | ` +
                `Emails: ${emailStr} [${totalSaved}/${maxResults}]`
            );

            if (totalSaved >= maxResults) {
                log.info(`Reached maxResults (${maxResults}). Stopping.`);
                await Actor.exit();
            }
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Request failed: ${request.url} — ${error.message}`);
    },
});

// ─── Run ──────────────────────────────────────────────────────────────────────
log.info(
    `🏃 Starting Instagram scraper | ` +
    `Hashtags: ${hashtags.join(', ')} | ` +
    `Min followers: ${minFollowers.toLocaleString()} | ` +
    `Max results: ${maxResults}`
);

await crawler.run();

log.info(`\n🎉 Done! Saved ${totalSaved} profiles to the dataset.`);

// ─── Stats summary ────────────────────────────────────────────────────────────
const dataset  = await Dataset.open();
const { items } = await dataset.getData();
const withEmail = items.filter(i => i.hasEmail).length;

log.info(`📊 Summary:`);
log.info(`   Total profiles saved : ${totalSaved}`);
log.info(`   Profiles with email  : ${withEmail}`);
log.info(`   Unique users scanned : ${seenUsers.size}`);

await Actor.setValue('SUMMARY', {
    totalSaved,
    withEmail,
    uniqueUsersScanned: seenUsers.size,
    hashtags,
    minFollowers,
});

await Actor.exit();
