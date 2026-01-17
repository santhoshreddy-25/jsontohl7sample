let parsedJson = {};
let mappings = [];
const segmentFieldCache = new Map();
let currentSegment = null;

/* -------------------------
   LOAD & PARSE JSON
-------------------------- */
function loadJson() {
    mappings = [];
    parsedJson = JSON.parse(document.getElementById("jsonInput").value);
    document.getElementById("jsonFields").innerHTML = "";
    extractFields(parsedJson, "");
}

/* -------------------------
   EXTRACT JSON FIELDS
-------------------------- */
function extractFields(obj, prefix) {
    for (let key in obj) {
        const path = prefix ? `${prefix}.${key}` : key;

        if (typeof obj[key] === "object") {
            extractFields(obj[key], path);
        } else {
            const li = document.createElement("li");
            li.textContent = path;
            li.draggable = true;

            li.addEventListener("dragstart", e => {
                e.dataTransfer.setData("text/plain", path);
            });

            document.getElementById("jsonFields").appendChild(li);
        }
    }
}

/* -------------------------
   RENDER HL7 FIELDS
-------------------------- */
async function loadSegments(version) {
    const res = await fetch(`/hl7-segments?version=${encodeURIComponent(version)}`);
    const data = await res.json();
    if (!res.ok) {
        throw new Error(
            `${data.error || "Failed to load segments."} (HTTP ${res.status})`
        );
    }
    return data.segments || [];
}

async function loadSegmentFields(version, segmentId) {
    const key = `${version}:${segmentId}`;
    if (segmentFieldCache.has(key)) {
        return segmentFieldCache.get(key);
    }

    const res = await fetch(
        `/hl7-segment-details?version=${encodeURIComponent(version)}&segment=${encodeURIComponent(segmentId)}`
    );
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || "Failed to load segment details.");
    }

    const fields = data.fields || [];
    segmentFieldCache.set(key, fields);
    return fields;
}

function renderFieldList(segmentId, fields) {
    const fieldContainer = document.getElementById("hl7Fields");
    const fieldCount = document.getElementById("fieldCount");
    fieldContainer.innerHTML = "";
    fieldCount.textContent = fields.length;

    if (!fields.length) {
        fieldContainer.innerHTML = "<li class=\"segment-error\">No fields found.</li>";
        return;
    }

    fields.forEach(f => {
        const li = document.createElement("li");
        const label = `${segmentId}-${f.field} ${f.name}`;
        li.className = "hl7";
        li.dataset.segment = segmentId;
        li.dataset.field = f.field;
        li.dataset.label = label;
        li.textContent = label;

        makeDroppable(li);
        fieldContainer.appendChild(li);
    });
}

async function selectSegment(version, segmentId) {
    currentSegment = segmentId;
    const segmentItems = document.querySelectorAll(".segment-item");
    segmentItems.forEach(item => {
        item.classList.toggle("active", item.dataset.segment === segmentId);
    });

    const fieldContainer = document.getElementById("hl7Fields");
    fieldContainer.innerHTML = "<li class=\"field-loading\">Loading fields...</li>";
    document.getElementById("fieldCount").textContent = "0";

    try {
        const fields = await loadSegmentFields(version, segmentId);
        renderFieldList(segmentId, fields);
    } catch (err) {
        console.error(err);
        fieldContainer.innerHTML = `<li class="segment-error">${err.message}</li>`;
    }
}

async function renderHL7Fields() {
    const segmentContainer = document.getElementById("hl7Segments");
    const fieldContainer = document.getElementById("hl7Fields");
    const segmentCount = document.getElementById("segmentCount");
    const fieldCount = document.getElementById("fieldCount");
    const version = document.getElementById("hl7Version").value;

    segmentContainer.innerHTML = "<li class=\"segment-loading\">Loading segments...</li>";
    fieldContainer.innerHTML = "<li class=\"field-loading\">Select a segment.</li>";
    segmentCount.textContent = "0";
    fieldCount.textContent = "0";

    let segments = [];
    try {
        segments = await loadSegments(version);
    } catch (err) {
        console.error(err);
        segmentContainer.innerHTML = `<li class="segment-error">${err.message}</li>`;
        return;
    }

    segmentContainer.innerHTML = "";
    segmentCount.textContent = segments.length;

    segments.forEach(segment => {
        const li = document.createElement("li");
        li.className = "segment-item";
        li.dataset.segment = segment.segment;
        li.textContent = `${segment.segment} - ${segment.title}`;
        li.addEventListener("click", () => {
            selectSegment(version, segment.segment);
        });
        segmentContainer.appendChild(li);
    });

    if (segments.length) {
        selectSegment(version, segments[0].segment);
    }
}

/* -------------------------
   MAKE HL7 FIELD DROPPABLE
-------------------------- */
function makeDroppable(li) {

    li.addEventListener("dragover", e => {
        e.preventDefault();
        li.classList.add("dragover");
    });

    li.addEventListener("dragleave", () => {
        li.classList.remove("dragover");
    });

    li.addEventListener("drop", e => {
        e.preventDefault();
        li.classList.remove("dragover");

        const jsonPath = e.dataTransfer.getData("text/plain");
        const segment = li.dataset.segment;
        const field = Number(li.dataset.field);
        const component = li.dataset.component
            ? Number(li.dataset.component)
            : null;

        // Prevent duplicate mapping on same HL7 field/component
        mappings = mappings.filter(m =>
            !(m.segment === segment && m.field === field && m.component === component)
        );

        mappings.push({ jsonPath, segment, field, component });

        li.textContent = `${li.dataset.label} -> ${jsonPath}`;
    });
}

/* -------------------------
   GENERATE HL7
-------------------------- */
function generateHL7() {
    fetch("/generate-hl7", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            inputJson: parsedJson,
            mappings,
            version: document.getElementById("hl7Version").value
        })
    })
    .then(res => res.json())
    .then(data => {
        document.getElementById("output").textContent = data.hl7;
    });
}

/* -------------------------
   INITIALIZE HL7 UI
-------------------------- */
document.addEventListener("DOMContentLoaded", () => {
    renderHL7Fields();
    const versionSelect = document.getElementById("hl7Version");
    versionSelect.addEventListener("change", () => {
        mappings = [];
        segmentFieldCache.clear();
        currentSegment = null;
        document.getElementById("output").textContent = "";
        renderHL7Fields();
    });
});
