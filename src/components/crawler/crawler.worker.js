const { EventEmitter } = require('events')
const { PlaywrightCrawler, Configuration } = require('crawlee')
const { BrowserName, DeviceCategory, OperatingSystemsName } = require('@crawlee/browser-pool')

const { config, logger, redis } = require('../../config')
const { githubService } = require('../github')
const { parserService } = require('../parser')

const namespace = 'jc-backend:crawler:worker'
const crawleeConfig = Configuration.getGlobalConfig()
crawleeConfig.set('logLevel', config.NODE_ENV === 'production' ? 'INFO' : 'DEBUG')

class CrawlerWorker extends EventEmitter {
    constructor() {
        super()
        this.emitter = new EventEmitter()
        this.emitter.on('crawled', async payload => {
            const { listingURL, html, imageUrls, listingPid } = payload

            // store data in git
            const gitUrl = await githubService.saveAdToPages({ url: listingURL, html, imageUrls })
            const recentListing = await toRecentListing(payload)
            const multi = redis.multi()
            multi.HSET('archives', listingPid, JSON.stringify(payload))
            addSetItem(multi, 'recent_listings', JSON.stringify(recentListing), 10)
            await multi.exec()
            this.emitter.emit('archived', { archived: { ...payload, gitUrl } })
        })
        this.crawlers = {}
    }
    async archive(options) {
        const { emitter, crawlers } = this
        const { listingURL, listingUUID, clientId } = options
        const isRunning = await redis.GET(`running-${listingUUID}`)

        if (!isRunning) {
            logger.debug({ namespace, message: 'crawling', listingUUID })
            // check to see if the user is at the maximum crawler limit first and wait for the next cycle, otherwise start a new crawl
            const userConfig = JSON.parse(await redis.HGET('userConfig', clientId))
            const numberOfCrawlers = await redis.ZSCORE(`crawlers`, clientId)

            await redis.SET(`running-${listingUUID}`, new Date().toLocaleString(), { EX: 30 })

            const multi = redis.multi()
            multi.HVALS(`queued`, clientId)
            multi.HKEYS(`queued`, clientId)
            const results = await multi.exec()
            const urls = Array.from(new Set([...results[0], `${listingUUID} ${listingURL}`])).filter(url => url)

            results[1].map(key => redis.HDEL(`queued`, key))

            if (!crawlers[clientId]) {
                crawlers[clientId] = await launchCrawler(emitter, clientId)
            } else if (!numberOfCrawlers || numberOfCrawlers < (userConfig?.crawlerLimit || 1)) {
                crawlers[clientId] = await launchCrawler(emitter, clientId)
            }
            run(crawlers[clientId], urls, options)
        } else {
            logger.debug({ namespace, message: `${new Date().toLocaleTimeString()}: queued clientId: ${clientId}` })
            redis.HSET(`queued`, clientId, `${listingUUID} ${listingURL}`)
        }
    }
}

module.exports = CrawlerWorker

function addSetItem(multi, setKey, item, maxSize) {
    const currentSize = multi.SCARD(setKey)

    if (currentSize < maxSize) {
        multi.SADD(setKey, item)
    } else {
        // Prune the Set by removing the first (oldest) member(s).
        const membersToRemove = currentSize - maxSize + 1
        for (let i = 0; i < membersToRemove; i++) {
            multi.SPOP(setKey)
        }

        // Now, you can safely add the new item to the Set.
        multi.SADD(setKey, item)
    }
}

async function toRecentListing(listing) {
    const { listingPid, html } = listing
    const metadata = await parserService.parseMetadata(html)

    return { listingPid, metadata, createdAt: Date.now() }
}
async function launchCrawler(emitter, clientId) {
    const crawler = new PlaywrightCrawler({
        launchContext: {
            useIncognitoPages: true,
            launchOptions: {
                args: [
                    '--no-zygote',
                    '--single-process',
                    '--remote-debugging-port=9222',
                    '--headless=new'
                ]
            }
        },
        browserPoolOptions: {
            useFingerprints: true, // this is the default
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: [{
                        name: BrowserName.edge,
                        minVersion: 96,
                    }],
                    devices: [
                        DeviceCategory.desktop,
                    ],
                    operatingSystems: [
                        OperatingSystemsName.windows,
                    ],
                },
            },
        },
        requestHandlerTimeoutSecs: 60,
        maxRequestRetries: 1,
        // Use the requestHandler to process each of the crawled pages.
        requestHandler: async ({ request, page, log }) => {
            const { options } = request.userData
            log.info(`Archiving ${request.url}...`)

            const html = await page.content()
            const gallery = await page.$('.gallery .swipe')
            await gallery.hover()
            await gallery.click()
            await page.waitForSelector('.gallery.big')

            const imageUrls = await page.evaluate(() => {
                const imageElements = document.querySelectorAll('.gallery.big .slide img')
                const urls = []

                // Loop through the image elements and extract the 'src' attribute
                imageElements.forEach((img) => {
                    const url = img.getAttribute('src')
                    urls.push(url)
                })

                return urls
            })

            logger.debug({ namespace, message: JSON.stringify({ url: request.url, html, imageUrls }) })
            emitter.emit('crawled', { url: request.url, html, imageUrls: Array.from(new Set(imageUrls)), ...options })
            const buffer = await page.screenshot()
            emitter.emit('screenshot', { buffer, uuid: options.listingUUID })
            await page.close()
        }
    })
    redis.ZINCRBY(`crawlers`, 1, clientId)
    return crawler
}
async function run(crawler, urlMap, options) {
    const urls = urlMap.map(m => m.split(' ')[1])
    const uuids = urlMap.map(m => m.split(' ')[0])

    try {
        if (crawler.running) {
            crawler.addRequests(urls.map(url => ({ url, userData: { options } })))
        } else {
            await crawler.run(urls.map(url => ({ url, userData: { options } })))
            crawler.requestQueue.drop()
        }
    } catch (error) {
        config.NODE_ENV === 'production' ? logger.error(error) : logger.debug({ namespace, message: error })
    } finally {
        const multi = redis.multi()
        uuids.forEach(uuid => multi.DEL(`running-${uuid}`))
        multi.exec()
    }
}
process.on('SIGUSR2', async () => {
    const queuedKeys = await redis.KEYS(`queued-*`)
    const runningKeys = await redis.KEYS(`running-*`)
    await Promise.all([
        redis.ZREMRANGEBYRANK(`crawlers`, 0, -1),
        ...queuedKeys.map(key => redis.DEL(key, 0, -1)),
        ...runningKeys.map(key => redis.DEL(key, 0, -1))
    ])
})
