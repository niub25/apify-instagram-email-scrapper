import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';
import { chromium } from 'playwright';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeHashtag(tag) {
    return String(tag ?? '').replace(/^#/, '').toLowerCase().trim();
}

function addUsername(usernames, username) {
    if (!username || typeof username !== 'string') return;
    usernames.add(username.trim().replace(/^@/, '').toLowerCase());
}

function extractUsernamesFromTagData(data) {
    const usernames = new Set();

    for (const item of (data?.items ?? [])) {
        addUsername(usernames, item?.user?.username || item?.owner?.username);
    }

    for (const item of (data?.ranked_items ?? [])) {
        addUsername(usernames, item?.user?.username || item?.owner?.username);
    }

    for (const key of ['recent', 'top']) {
        for (const section of (data?.data?.[key]?.sections ?? [])) {
            for (const media of [
                ...(section?.layout_content?.medias ?? []),
                ...(section?.layout_content?.fill_media ?? []),
            ]) {
                addUsername(usernames, media?.media?.user?.username || media?.media?.owner?.username);
            }
        }
    }

    return [...usernames];
}

function getNextMaxId(data) {
    return data?.next_max_id
        ?? data?.nextMaxId
        ?? data?.data?.recent?.next_max_id
        ?? null;
}

function hasMorePages(data, nextMaxId) {
    if (typeof data?.more_available === 'boolean') return data.more_available && !!nextMaxId;
    return !!nextMaxId;
}

await Actor.init();

const input = await Actor.getInput();
const {
    hashtags: seedHashtags = ['running', 'marathon', 'halfmarathon', 'runnersofinstagram', 'runningcoach'],
    maxResults = 10000,
    maxHashtags = 700,
    maxPagesPerHashtag = 500,
    relatedSearchCount = 50,
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

log.info('🌐 Launching browser...');
const proxyUrl = await proxyConfig.newUrl('ig_browser');
const proxyHost = proxyUrl ? new URL(proxyUrl) : null;

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: proxyHost ? {
        server: `${proxyHost.protocol}//${proxyHost.host}`,
        username: proxyHost.username ? decodeURIComponent(proxyHost.username) : undefined,
        password: proxyHost.password ? decodeURIComponent(proxyHost.password) : undefined,
    } : undefined,
});

const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
});

await context.addCookies([
    { name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    ...(csrfToken ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }] : []),
]);

const igPage = await context.newPage();

log.info('📱 Establishing Instagram session...');
await igPage.goto('https://www.instagram.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
}).catch(e => log.warning(`Nav: ${e.message}`));

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

        if (result?.status === 429) {
            const waitMs = Math.min(30000 * Math.pow(2, retryCount), 300000);
            log.warning(`⏳ Rate limited (429) - waiting ${waitMs / 1000}s before retry ${retryCount + 1}/5...`);
            await sleep(waitMs);
            if (retryCount < 5) return igApiFetch(apiUrl, retryCount + 1);
            return null;
        }

        if (result?.status === 401 || result?.status === 403) {
            log.warning(`🔒 Auth error (${result.status}) - session may have expired`);
            return null;
        }

        if (result?.error || !result?.data) return null;
        return result.data;
    } catch (e) {
        log.warning(`igApiFetch error: ${e.message}`);
        return null;
    }
}

async function discoverRelatedHashtags(tag) {
    const discovered = new Set();

    const relData = await igApiFetch(
        `https://www.instagram.com/api/v1/tags/${encodeURIComponent(tag)}/related/`
    );
    for (const rel of (relData?.related_tags ?? [])) {
        const relatedTag = normalizeHashtag(rel?.name);
        if (relatedTag) discovered.add(relatedTag);
    }

    const searchData = await igApiFetch(
        `https://www.instagram.com/api/v1/tags/search/?q=${encodeURIComponent(tag)}&count=${relatedSearchCount}`
    );
    for (const result of (searchData?.results ?? [])) {
        const relatedTag = normalizeHashtag(result?.name);
        if (relatedTag) discovered.add(relatedTag);
    }

    return [...discovered];
}

async function fetchHashtagPage(tag, maxId) {
    let mobileUrl = `https://i.instagram.com/api/v1/feed/tag/?tag_name=${encodeURIComponent(tag)}&rank_token=&ranked_content=true`;
    if (maxId) mobileUrl += `&max_id=${encodeURIComponent(maxId)}`;

    const mobileData = await igApiFetch(mobileUrl);
    if (mobileData) {
        const nextMaxId = getNextMaxId(mobileData);
        return {
            usernames: extractUsernamesFromTagData(mobileData),
            nextMaxId,
            moreAvailable: hasMorePages(mobileData, nextMaxId),
            source: 'mobile',
        };
    }

    let webUrl = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
    if (maxId) webUrl += `&max_id=${encodeURIComponent(maxId)}`;

    const webData = await igApiFetch(webUrl);
    if (webData) {
        const nextMaxId = getNextMaxId(webData);
        return {
            usernames: extractUsernamesFromTagData(webData),
            nextMaxId,
            moreAvailable: hasMorePages(webData, nextMaxId),
            source: 'web',
        };
    }

    return null;
}

log.info('🔍 Testing API...');
const testTag = normalizeHashtag(seedHashtags[0]) || 'running';
const testResult = await fetchHashtagPage(testTag, '');
if (!testResult) {
    log.error('❌ API test FAILED - get fresh sessionid + csrftoken from Chrome and try again.');
    await browser.close();
    await Actor.exit();
}
log.info(`✅ API working via [${testResult.source}]`);

const seenUsers = new Set();
const seenHashtags = new Set();
const hashtagQueue = [...new Set(seedHashtags.map(normalizeHashtag).filter(Boolean))];

log.info(`\n🏷️ Instagram Username Discovery`);
log.info(`   Seed hashtags       : ${hashtagQueue.length}`);
log.info(`   Max total hashtags  : ${maxHashtags}`);
log.info(`   Pages per hashtag   : ${maxPagesPerHashtag}`);
log.info(`   Related search count: ${relatedSearchCount}`);
log.info(`   Max usernames       : ${maxResults}`);

while (hashtagQueue.length > 0 && seenHashtags.size < maxHashtags && seenUsers.size < maxResults) {
    const tag = hashtagQueue.shift();
    if (!tag || seenHashtags.has(tag)) continue;
    seenHashtags.add(tag);

    log.info(`\n📌 [${seenHashtags.size}/${maxHashtags}] #${tag}`);

    if (seenHashtags.size < maxHashtags) {
        const related = await discoverRelatedHashtags(tag);
        let addedCount = 0;
        for (const relTag of related) {
            if (seenHashtags.size + hashtagQueue.length >= maxHashtags) break;
            if (!seenHashtags.has(relTag) && !hashtagQueue.includes(relTag)) {
                hashtagQueue.push(relTag);
                addedCount++;
            }
        }
        if (addedCount > 0) log.info(`   🔍 +${addedCount} related tags -> queue: ${hashtagQueue.length}`);
    }

    let pageNum = 0;
    let nextMaxId = '';
    let moreAvailable = true;
    let totalThisTag = 0;

    while (pageNum < maxPagesPerHashtag && moreAvailable && seenUsers.size < maxResults) {
        pageNum++;
        const result = await fetchHashtagPage(tag, nextMaxId);

        if (!result) {
            log.warning(`   p${pageNum}: failed - stopping tag`);
            break;
        }

        let newCount = 0;
        for (const username of result.usernames) {
            if (seenUsers.has(username)) continue;

            seenUsers.add(username);
            newCount++;
            totalThisTag++;

            await Dataset.pushData({
                username,
                profileUrl: `https://www.instagram.com/${username}/`,
                sourceHashtag: tag,
                source: result.source,
                scrapedAt: new Date().toISOString(),
            });

            if (seenUsers.size >= maxResults) break;
        }

        log.info(`   p${pageNum} [${result.source}]: +${newCount} | tag: ${totalThisTag} | total: ${seenUsers.size} | next: ${result.nextMaxId ? '✅' : '❌'}`);

        if (!result.nextMaxId || !result.moreAvailable || newCount === 0) {
            moreAvailable = false;
            break;
        }

        nextMaxId = result.nextMaxId;
        await sleep(600);
    }

    log.info(`   ✅ #${tag}: ${totalThisTag} new usernames over ${pageNum} page(s)`);
    await sleep(400);
}

await browser.close();

log.info(`\n🎉 Done!`);
log.info(`   Hashtags processed : ${seenHashtags.size}`);
log.info(`   Usernames saved    : ${seenUsers.size}`);

await Actor.setValue('SUMMARY', {
    hashtagsProcessed: seenHashtags.size,
    usernamesSaved: seenUsers.size,
});

await Actor.exit();
