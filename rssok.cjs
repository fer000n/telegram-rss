const { telegram_rss } = require('telegram-rss');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { parseStringPromise, Builder } = require('xml2js');

// Create images directory if it doesn't exist
const imageDir = path.join(__dirname, 'images');
if (!fs.existsSync(imageDir)) {
    fs.mkdirSync(imageDir);
}

// Simple MIME type detection from magic numbers
function detectMimeType(buffer) {
    const signatures = {
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/png': [0x89, 0x50, 0x4E, 0x47],
        'image/gif': [0x47, 0x49, 0x46, 0x38],
        'image/webp': [0x52, 0x49, 0x46, 0x46]
    };

    for (const [mimeType, signature] of Object.entries(signatures)) {
        if (signature.every((byte, index) => buffer[index] === byte)) {
            return mimeType;
        }
    }
    return 'image/jpeg'; // default fallback
}

// Function to get file extension from MIME type
function getExtFromMime(mimeType) {
    const extensions = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp'
    };
    return extensions[mimeType] || '.jpg';
}

// Function to download image and get its metadata
async function downloadImage(imageUrl, filename) {
    return new Promise((resolve, reject) => {
        https.get(imageUrl, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download image: ${response.statusCode}`));
                return;
            }

            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            
            response.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const mimeType = detectMimeType(buffer);
                    const ext = getExtFromMime(mimeType);
                    const filenameWithExt = filename.replace(/\.[^/.]+$/, '') + ext;
                    const filepath = path.join(imageDir, filenameWithExt);

                    // Write file
                    fs.writeFileSync(filepath, buffer);

                    resolve({
                        path: filepath,
                        filename: filenameWithExt,
                        size: buffer.length,
                        mimeType: mimeType
                    });
                } catch (error) {
                    reject(error);
                }
            });

            response.on('error', reject);
        }).on('error', reject);
    });
}

const serverport = process.env.PORT || 80;
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Serve images if the request is for an image
    if (pathname.startsWith('/images/')) {
        const imagePath = path.join(__dirname, pathname);
        try {
            const imageBuffer = fs.readFileSync(imagePath);
            const mimeType = detectMimeType(imageBuffer);
            res.setHeader('Content-Type', mimeType);
            res.end(imageBuffer);
        } catch (error) {
            res.statusCode = 404;
            res.end('Image not found');
        }
        return;
    }

    const queryObject = parsedUrl.query;
    const telegram_channel = queryObject.channel || 'telegram';
    const serverUrl = `http://php8.com`;

    try {
        let result = await telegram_rss(telegram_channel);
        let parsedData = await parseStringPromise(result);
        let channel = parsedData.rss.channel[0];
        let realChannelTitle = channel.title[0] || "Telegram Channel";
        channel.title = [realChannelTitle];
        channel.link = [`https://t.me/${telegram_channel}`];
        channel.description = [""];
        let latestPubDate = new Date().toUTCString();
        channel.pubDate = [latestPubDate];
        channel.lastBuildDate = [latestPubDate];
        channel["atom:link"] = [{ $: { rel: "self", type: "application/rss+xml", href: "" } }];

        // Process each item and download images
        channel.item = await Promise.all(channel.item.map(async item => {
            let imageUrl = item.image ? item.image[0].url[0] : "";
            let pubDate = item.pubDate && item.pubDate[0] ? new Date(item.pubDate[0]).toUTCString() : latestPubDate;
            let postLink = item.link[0];
            let descriptionText = item.description ? item.description[0] : item.title[0];

            let enclosure = [];
            if (imageUrl) {
                try {
                    const timestamp = new Date().getTime();
                    const tempFilename = `${timestamp}.tmp`;
                    
                    // Download and get image metadata
                    const imageData = await downloadImage(imageUrl, tempFilename);
                    
                    // Update the image URL to point to our server with correct filename
                    const localImageUrl = `${serverUrl}/images/${imageData.filename}`;
                    
                    enclosure = [{
                        $: {
                            url: localImageUrl,
                            type: imageData.mimeType,
                            length: imageData.size.toString()
                        }
                    }];
                } catch (error) {
                    console.error("Error downloading image:", error);
                    // Keep original image URL if download fails
                    enclosure = [{
                        $: {
                            url: imageUrl,
                            type: "image/jpeg",
                            length: "0"
                        }
                    }];
                }
            }

            return {
                title: ["[Photo]"],
                description: [descriptionText],
                pubDate: [pubDate],
                link: [postLink],
                guid: [postLink],
                enclosure: enclosure
            };
        }));

        let builder = new Builder({ headless: true, xmldec: { version: "1.0", encoding: "UTF-8" } });
        let newXml = builder.buildObject({ rss: { $: { "xmlns:atom": "http://www.w3.org/2005/Atom", version: "2.0" }, channel } });

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(newXml);
    } catch (error) {
        console.error("Error processing RSS:", error);
        res.statusCode = 500;
        res.end("Error generating RSS feed.");
    }
});

server.listen(serverport, () => {
    console.log(`Server running at port ${serverport}`);
});