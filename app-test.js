import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer();
const app = express();

// Request logging middleware (logs method, path, ip, and short body)
app.use((req, res, next) => {
    const shortBody = req.body && Object.keys(req.body).length ? {
        keys: Object.keys(req.body),
        sample: Object.fromEntries(Object.entries(req.body).slice(0, 5))
    } : {};
    logInfo('Incoming request', { method: req.method, path: req.path, ip: req.ip, body: shortBody });
    next();
});

const CONFIG_FILE = path.join(__dirname, 'org-config.json');
const ORG_FILE = path.join(__dirname, 'org-list.json');

const MIN_ORG_ID = 1000000000000;
const MAX_ORG_ID = 1999999999999;

function generateOrgId(orgs) {
    let maxId = MIN_ORG_ID - 1;
    for (const o of orgs) {
        const idNum = Number(o.ORG_ID);
        if (Number.isFinite(idNum) && idNum >= MIN_ORG_ID && idNum <= MAX_ORG_ID) {
            if (idNum > maxId) maxId = idNum;
        }
    }
    const next = maxId + 1;
    if (next > MAX_ORG_ID) {
        throw new Error('OrgId range exhausted');
    }
    return next;
}
// Helper to read JSON file
function readJson(file) {
    if (!fs.existsSync(file)) return {};
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) return {};
    try {
        return JSON.parse(content);
    } catch (e) {
        console.error(`Error parsing JSON from ${file}:`, e);
        return {};
    }
}

// Helper to write JSON file
function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Simple logging helpers
function logInfo(message, meta = {}) {
    console.log(`[INFO]  ${new Date().toISOString()} - ${message}`, Object.keys(meta).length ? meta : '');
}

function logError(message, meta = {}) {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, Object.keys(meta).length ? meta : '');
}

// Default config when org-specific config is missing
const DEFAULT_CONFIG = {
    isDefault: true,
    enabledFeatures: ['2', '5', '6', '9', '10', '11'],
    includeCrawledURLCountInResponse: false,
    throttleTimeInterval: '1D',
    whiteListedDomains: [
        'help.zoho.com',
        'docs.catalyst.zoho.com',
        'blogs.manageengine.com',
        'www.manageengine.com',
        'blog.zoho.com'
    ],
    throttleRequestCount: 50,
    maxDepthAllowed: -1,
    maxPagesToFetchAllowed: 20000,
    maxAsyncResponseRate: 100,
    requestPriority: 5,
    isDynamicCrawlingAllowed: true,
    enabledCrawlerFields: ['Html', 'OutGoingURLs', 'Markdown'],
    additionalQueryParams: ['requestId', 'recordId', 'seedStatus', 'recordStatus']
};

// --------------------------------------------------
// Single entrypoint: POST /api/v2/crawler (form-data)
// --------------------------------------------------
app.post('/api/v2/crawler', upload.none(), (req, res) => {
    const { action } = req.body || {};

    if (!action) {
        return res.status(400).json({ message: 'Missing action parameter', status: 'error' });
    }

    switch (action) {
        // 1.1 Get All Organizations
        // POST /api/v2/crawler?action=getAllOrg
        case 'getAllOrg': {
            let orgs = readJson(ORG_FILE);
            if (!Array.isArray(orgs)) orgs = [];

            return res.json({
                code: 'SUCCESS',
                details: orgs,
                message: 'Org list fetched successfully',
                status: 'success'
            });
        }

        case 'createOrg': {
            const { orgName } = req.body;

            if (!orgName) {
                return res.status(400).json({
                    code: 'ERROR',
                    message: 'Missing orgName',
                    status: 'error'
                });
            }

            let orgs = readJson(ORG_FILE);
            if (!Array.isArray(orgs)) orgs = [];

            // Check for existing orgName
            const nameExists = orgs.some(o => o.ORG_NAME === orgName);
            if (nameExists) {
                return res.status(409).json({
                    code: 'ERROR',
                    message: 'OrgName already exists',
                    status: 'error'
                });
            }

            let newId;
            try {
                newId = generateOrgId(orgs);
            } catch (e) {
                return res.status(500).json({
                    code: 'ERROR',
                    message: e.message || 'Failed to generate OrgId',
                    status: 'error'
                });
            }

            const newOrg = {
                ORG_ID: newId,
                ORG_NAME: orgName
            };

            orgs.push(newOrg);
            writeJson(ORG_FILE, orgs);

            return res.json({
                code: 'SUCCESS',
                details: newOrg,
                message: 'Org created successfully',
                status: 'success'
            });
        }
        // 1.2 Get Organization Configuration
        // POST /api/v2/crawler?action=getOrgConfig
        case 'getOrgConfig': {
            const { orgId } = req.body;

            if (!orgId) {
                return res.status(400).json({ message: 'Missing orgId', status: 'error' });
            }

            // First ensure orgId exists in org list
            let orgs = readJson(ORG_FILE);
            if (!Array.isArray(orgs)) orgs = [];

            const orgExists = orgs.some(o => String(o.ORG_ID) === String(orgId));
            if (!orgExists) {
                return res.status(500).json({
                    code: 'ERROR',
                    message: 'OrgId not found',
                    status: 'error'
                });
            }

            const configs = readJson(CONFIG_FILE); // { [orgId]: configObj }
            let config = configs[orgId];

            // If org config does not exist, return a default config with isDefault: true
            if (!config) {
                const allConfigs = Object.values(configs);
                const defaultInFile = allConfigs.find(c => c && c.isDefault === true);
                config = defaultInFile || DEFAULT_CONFIG;
            }

            return res.json({
                code: 'SUCCESS',
                details: config,
                message: 'Org config fetched successfully',
                status: 'success'
            });
        }

        // 1.3 Update/Create Organization Configuration
        // POST /api/v2/crawler?action=updateOrgConfig
        case 'updateOrgConfig': {
            const { orgId } = req.body;
            let { config } = req.body;

            if (!orgId || !config) {
                logError('UpdateOrgConfig failed: missing orgId or config', { body: req.body });
                return res.status(400).json({ message: 'Missing orgId or config', status: 'error' });
            }

            // config comes as JSON string in form-data
            if (typeof config === 'string') {
                try {
                    config = JSON.parse(config);
                } catch (e) {
                    logError('UpdateOrgConfig failed: invalid JSON', { orgId, rawConfig: config });
                    return res
                        .status(400)
                        .json({ message: 'Invalid JSON in config field', status: 'error' });
                }
            }

            // Load existing configs and perform partial merge
            const configs = readJson(CONFIG_FILE); // { [orgId]: configObj }
            const existingConfig = configs[orgId] || DEFAULT_CONFIG;

            // Merge: only incoming keys overwrite existing ones
            const mergedConfig = {
                ...existingConfig,
                ...config
            };

            configs[orgId] = mergedConfig;
            writeJson(CONFIG_FILE, configs);
            logInfo('Org config updated', { orgId });

            // Ensure org exists in org list file
            let orgs = readJson(ORG_FILE);
            if (!Array.isArray(orgs)) orgs = [];

            const existingOrg = orgs.find(o => String(o.ORG_ID) === String(orgId));

            // If org does not exist, create a new entry
            if (!existingOrg) {
                const orgName = req.body.orgName || `Org-${orgId}`;
                const newOrg = {
                    ORG_ID: Number.isNaN(Number(orgId)) ? orgId : Number(orgId),
                    ORG_NAME: orgName
                };
                orgs.push(newOrg);
                writeJson(ORG_FILE, orgs);
                logInfo('Org auto-created during updateOrgConfig', newOrg);
            }

            return res.json({
                code: 'SUCCESS',
                details: mergedConfig,
                message: 'Org config updated successfully',
                note:'Note for UI Developers: The response contains the configuration (details) after update.This will not be returned in actual API response.',
                status: 'success'
            });
        }

        default:
            return res.status(400).json({ message: `Unknown action: ${action}`, status: 'error' });
    }
});

// Start server on 8080 to match base URL
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});