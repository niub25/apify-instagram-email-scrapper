import { Actor } from 'apify';
import { chromium } from 'playwright';
 
await Actor.init();
 
const input = await Actor.getInput();
const {
    hashtags: seedHashtags = ['running','marathon','halfmarathon','runnersofinstagram','runningcoach'],
    maxHashtags        = 3000,
    maxPagesPerHashtag = 50,
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;
 
if (!sessionId) {
    console.log('ERROR: sessionId is required!');
    await Actor.exit();
}
 
const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);
 
// ─── Restore state after migration ───────────────────────────────────────────
 
const savedState = await Actor.getValue('STATE') ?? {};
const seenUsers    = new Set(savedState.seenUsers    ?? []);
const seenHashtags = new Set(savedState.seenHashtags ?? []);
const hashtagQueue = savedState.hashtagQueue
    ?? [...new Set(seedHashtags.map(t => t.replace(/^#/, '').toLowerCase().trim()).filter(Boolean))];
 
console.log(`Restored state: ${seenUsers.size} users, ${seenHashtags.size} hashtags done, ${hashtagQueue.length} in queue`);
 
// ─── Save state on migration ──────────────────────────────────────────────────
 
Actor.on('migrating', async () => {
    await Actor.setValue('STATE', {
        seenUsers:    [...seenUsers],
        seenHashtags: [...seenHashtags],
        hashtagQueue,
    });
    console.log(`State saved: ${seenUsers.size} users, ${seenHashtags.size} hashtags, ${hashtagQueue.length} queued`);
});
 
// ─── Launch browser ───────────────────────────────────────────────────────────
 
console.log('Launching browser...');
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
    { name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    ...(csrfToken ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }] : []),
]);
 
const igPage = await context.newPage();
 
console.log('Navigating to Instagram...');
await igPage.goto('https://www.instagram.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
}).catch(e => console.log(`Nav warning: ${e.message}`));
 
// ─── Instagram API caller ─────────────────────────────────────────────────────
 
async function igFetch(url) {
    try {
        const result = await igPage.evaluate(async (u) => {
            try {
                const r = await fetch(u, {
                    headers: {
                        'X-IG-App-ID': '936619743392459',
                        'X-ASBD-ID': '129477',
                        'Accept': '*/*',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    credentials: 'include',
                });
                if (!r.ok) return { error: r.status };
                return { data: await r.json() };
            } catch (e) {
                return { error: e.message };
            }
        }, url);
        return result?.data ?? null;
    } catch {
        return null;
    }
}
 
// ─── Fetch one page of hashtag posts ─────────────────────────────────────────
 
async function fetchHashtagPage(tag, maxId) {
    // Mobile feed API (deep pagination)
    let url = `https://i.instagram.com/api/v1/feed/tag/?tag_name=${encodeURIComponent(tag)}&rank_token=&ranked_content=true`;
    if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
    const mobile = await igFetch(url);
    if (mobile) {
        return {
            usernames: (mobile.items ?? []).map(i => i?.user?.username || i?.owner?.username).filter(Boolean),
            nextMaxId: mobile.next_max_id ?? null,
            moreAvailable: mobile.more_available ?? false,
            source: 'mobile',
        };
    }
 
    // Web API fallback
    let webUrl = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
    if (maxId) webUrl += `&max_id=${encodeURIComponent(maxId)}`;
    const web = await igFetch(webUrl);
    if (web) {
        const usernames = [];
        for (const key of ['recent', 'top']) {
            for (const section of (web?.data?.[key]?.sections ?? [])) {
                for (const m of [...(section?.layout_content?.medias ?? []), ...(section?.layout_content?.fill_media ?? [])]) {
                    const u = (m?.media?.user || m?.media?.owner)?.username;
                    if (u) usernames.push(u);
                }
            }
        }
        return {
            usernames,
            nextMaxId: web?.data?.recent?.next_max_id ?? null,
            moreAvailable: !!web?.data?.recent?.next_max_id,
            source: 'web',
        };
    }
 
    return null;
}
 
// ─── Discover related hashtags ────────────────────────────────────────────────
 
async function discoverRelated(tag) {
    const found = new Set();
    const rel = await igFetch(`https://www.instagram.com/api/v1/tags/${encodeURIComponent(tag)}/related/`);
    for (const r of (rel?.related_tags ?? [])) { if (r?.name) found.add(r.name.toLowerCase().trim()); }
    const search = await igFetch(`https://www.instagram.com/api/v1/tags/search/?q=${encodeURIComponent(tag)}&count=15`);
    for (const r of (search?.results ?? [])) { if (r?.name) found.add(r.name.toLowerCase().trim()); }
    return [...found];
}
 
// ─── Test API ─────────────────────────────────────────────────────────────────
 
console.log('Testing API...');
const test = await fetchHashtagPage('running', '');
if (!test) {
    console.log('ERROR: API test failed. Get fresh sessionid + csrftoken from Chrome and try again.');
    await browser.close();
    await Actor.exit();
}
console.log(`API working via [${test.source}]`);
 
// ─── Main: discover usernames ─────────────────────────────────────────────────
 
console.log(`\nStarting username discovery`);
console.log(`  Seed hashtags     : ${seedHashtags.length}`);
console.log(`  Max hashtags      : ${maxHashtags}`);
console.log(`  Pages per hashtag : ${maxPagesPerHashtag}`);
console.log(`  Already done      : ${seenHashtags.size} hashtags, ${seenUsers.size} users\n`);
 
const { Dataset } = await import('crawlee');
 
while (hashtagQueue.length > 0 && seenHashtags.size < maxHashtags) {
    const tag = hashtagQueue.shift();
    if (!tag || seenHashtags.has(tag)) continue;
    seenHashtags.add(tag);
 
    console.log(`\n[${seenHashtags.size}/${maxHashtags}] #${tag}`);
 
    // Discover related hashtags first
    if (seenHashtags.size <= maxHashtags) {
        const related = await discoverRelated(tag);
        let added = 0;
        for (const r of related) {
            if (!seenHashtags.has(r) && !hashtagQueue.includes(r)) {
                hashtagQueue.push(r);
                added++;
            }
        }
        if (added > 0) console.log(`  +${added} related tags → queue: ${hashtagQueue.length}`);
    }
 
    // Paginate this hashtag
    let pageNum = 0, nextMaxId = '', moreAvailable = true, tagTotal = 0;
    const newUsersThisTag = [];
 
    while (pageNum < maxPagesPerHashtag && moreAvailable) {
        pageNum++;
        const result = await fetchHashtagPage(tag, nextMaxId);
        if (!result) { console.log(`  p${pageNum}: failed`); break; }
 
        let newCount = 0;
        for (const u of result.usernames) {
            if (u && !seenUsers.has(u)) {
                seenUsers.add(u);
                newUsersThisTag.push(u);
                newCount++;
                tagTotal++;
            }
        }
 
        console.log(`  p${pageNum} [${result.source}]: +${newCount} | tag total: ${tagTotal} | all time: ${seenUsers.size} | next: ${result.nextMaxId ? '✅' : '❌'}`);
 
        if (!result.nextMaxId || !result.moreAvailable || newCount === 0) {
            moreAvailable = false;
            break;
        }
        nextMaxId = result.nextMaxId;
        await new Promise(r => setTimeout(r, 500));
    }
 
    // Save new usernames to dataset
    if (newUsersThisTag.length > 0) {
        for (const username of newUsersThisTag) {
            await Dataset.pushData({ username, discoveredFrom: tag, scrapedAt: new Date().toISOString() });
        }
        console.log(`  Saved ${newUsersThisTag.length} new usernames`);
    }
 
    // Persist state every 10 hashtags
    if (seenHashtags.size % 10 === 0) {
        await Actor.setValue('STATE', {
            seenUsers:    [...seenUsers],
            seenHashtags: [...seenHashtags],
            hashtagQueue,
        });
        console.log(`  State saved (${seenHashtags.size} hashtags done)`);
    }
 
    await new Promise(r => setTimeout(r, 400));
}
 
await browser.close();
 
// Final state save
await Actor.setValue('STATE', {
    seenUsers:    [...seenUsers],
    seenHashtags: [...seenHashtags],
    hashtagQueue: [],
});
 
console.log(`\nDone!`);
console.log(`  Hashtags processed : ${seenHashtags.size}`);
console.log(`  Unique usernames   : ${seenUsers.size}`);
 
await Actor.exit();
