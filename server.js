const express = require("express");
const bodyParser = require("body-parser");
const https = require("https");

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static("public"));

const segmentListCache = new Map();
const segmentDetailCache = new Map();

function normalizeVersion(version) {
    if (typeof version !== "string" || !version.trim()) {
        return "2.5";
    }
    const clean = version.trim();
    if (clean.startsWith("2.")) {
        return clean;
    }
    if (/^\d+$/.test(clean)) {
        return `2.${clean}`;
    }
    return clean;
}

function fetchJson(url, retries = 4) {
    return new Promise((resolve, reject) => {
        const attempt = attemptNumber => {
            const req = https.get(
                url,
                {
                    headers: {
                        "User-Agent": "json-to-hl7-mapper",
                        Accept: "application/json"
                    }
                },
                res => {
                let data = "";
                res.on("data", chunk => (data += chunk));
                res.on("end", () => {
                    if (res.statusCode !== 200) {
                        if (attemptNumber < retries) {
                            return setTimeout(() => attempt(attemptNumber + 1), 500);
                        }
                        return reject(
                            new Error(`Failed request (${res.statusCode}): ${url}`)
                        );
                    }

                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            req.on("error", err => {
                if (attemptNumber < retries) {
                    return setTimeout(() => attempt(attemptNumber + 1), 500);
                }
                reject(err);
            });
        };

        attempt(0);
    });
}

function getSegments(version) {
    const normalized = normalizeVersion(version);
    if (segmentListCache.has(normalized)) {
        return segmentListCache.get(normalized);
    }

    const url = `https://hl7-definition.caristix.com/v2-api/1/HL7v${normalized}/Segments`;
    const promise = fetchJson(url).then(list =>
        list.map(seg => ({
            segment: seg.id,
            title: seg.label && seg.label.includes(" - ")
                ? seg.label.split(" - ")[1]
                : seg.id
        }))
    );

    segmentListCache.set(normalized, promise);
    return promise;
}

function getSegmentDetail(version, segmentId) {
    const normalized = normalizeVersion(version);
    const key = `${normalized}:${segmentId}`;
    if (segmentDetailCache.has(key)) {
        return segmentDetailCache.get(key);
    }

    const url = `https://hl7-definition.caristix.com/v2-api/1/HL7v${normalized}/Segments/${segmentId}`;
    const promise = fetchJson(url)
        .then(detail => {
            const fields = (detail.fields || [])
                .map(field => {
                    const pos = field.position || field.id || "";
                    const match = pos.match(/[.-](\d+)$/);
                    if (!match) return null;
                    const num = Number(match[1]);
                    return {
                        field: num,
                        name: field.name || `Field ${num}`
                    };
                })
                .filter(Boolean)
                .sort((a, b) => a.field - b.field);

            return {
                segment: segmentId,
                title: detail.longName || segmentId,
                fields
            };
        })
        .then(result => {
            if (!result.fields || result.fields.length === 0) {
                segmentDetailCache.delete(key);
            }
            return result;
        });

    segmentDetailCache.set(key, promise);
    return promise;
}

app.get("/hl7-segments", async (req, res) => {
    const version = normalizeVersion(req.query.version || "2.5");
    try {
        const segments = await getSegments(version);
        res.json({ segments });
    } catch (err) {
        console.error("hl7-segments error:", err.message);
        res.status(500).json({ error: err.message || "Failed to load segments." });
    }
});

app.get("/hl7-segment-details", async (req, res) => {
    const version = req.query.version || "2.5";
    const segmentId = (req.query.segment || "").toUpperCase();
    if (!segmentId) {
        return res.status(400).json({ error: "segment is required" });
    }

    const normalized = normalizeVersion(version);
    segmentDetailCache.delete(`${normalized}:${segmentId}`);

    try {
        const detail = await getSegmentDetail(version, segmentId);
        res.json(detail);
    } catch (err) {
        console.error("hl7-segment-details error:", err.message);
        res.status(500).json({ error: err.message || "Failed to load segment details." });
    }
});

app.post("/generate-hl7", (req, res) => {
    const { inputJson, mappings, version } = req.body;

    /* -------------------------
       MSH SEGMENT
    -------------------------- */
    const msh =
        "MSH|^~\\&|APP|HOSP|SYS|FAC|" +
        getDate() +
        "||ADT^A01|MSG00001|P|" +
        (version || "2.3");

    /* -------------------------
       SEGMENTS (PID, NK1, PV1, OBR, etc.)
    -------------------------- */
    const segmentFields = new Map();
    const segmentOrder = [];

    mappings.forEach(m => {
        const value = getValue(inputJson, m.jsonPath);
        if (value === undefined || value === null || value === "") return;

        const segment = (m.segment || "PID").toUpperCase();
        if (segment === "MSH") return;

        if (!segmentFields.has(segment)) {
            const fields = [];
            fields[0] = segment;
            segmentFields.set(segment, fields);
            segmentOrder.push(segment);
        }

        const fields = segmentFields.get(segment);

        // Composite field (PID-5.1, PV1-3.2, etc.)
        if (m.component) {
            if (!fields[m.field]) {
                fields[m.field] = [];
            }
            fields[m.field][m.component - 1] = value;
        }
        // Simple field (PID-3, NK1-2, etc.)
        else {
            fields[m.field] = value;
        }
    });

    const segments = [msh];

    segmentOrder.forEach(segment => {
        const fields = segmentFields.get(segment);
        if (!fields) return;

        for (let i = 0; i < fields.length; i++) {
            if (Array.isArray(fields[i])) {
                fields[i] = fields[i].join("^");
            }
        }

        segments.push(fields.join("|"));
    });

    /* -------------------------
       FINAL HL7 MESSAGE
    -------------------------- */
    const hl7 = segments.join("\r");

    res.json({ hl7 });
});

/* -------------------------
   UTILITY FUNCTIONS
-------------------------- */
function getValue(obj, path) {
    return path.split(".").reduce((o, p) => (o ? o[p] : null), obj);
}

function getDate() {
    const d = new Date();
    return (
        d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, "0") +
        String(d.getDate()).padStart(2, "0")
    );
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
