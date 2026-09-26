const election = window.NTPC_ELECTION_2026;
const state = { selectedDistrict: 5, hoverDistrict: null };

const mapCanvas = document.querySelector("#mapCanvas");
const districtNumber = document.querySelector("#districtNumber");
const districtName = document.querySelector("#districtName");
const districtAreas = document.querySelector("#districtAreas");
const incumbentList = document.querySelector("#incumbentList");
const challengerList = document.querySelector("#challengerList");
const incumbentCount = document.querySelector("#incumbentCount");
const challengerCount = document.querySelector("#challengerCount");

let svg;
let featureNodes = [];

function getDistrict(id) {
  return election.districts.find((district) => district.id === Number(id));
}

function getDistrictForArea(area) {
  return election.districts.find((district) => district.areas.includes(area));
}

function partyClass(party) {
  if (party === "民主進步黨") return "dpp";
  if (party === "中國國民黨") return "kmt";
  if (party === "台灣民眾黨") return "tpp";
  if (party === "無黨籍") return "independent";
  return "other";
}

function candidateMarkup(candidate) {
  const [name, party] = candidate;
  return `
    <article class="candidate-row">
      <span class="party-mark ${partyClass(party)}" aria-hidden="true"></span>
      <div>
        <strong>${name}</strong>
        <small>${party}</small>
      </div>
    </article>
  `;
}

function renderCandidateList(target, candidates, emptyMessage) {
  target.innerHTML = candidates.length
    ? candidates.map(candidateMarkup).join("")
    : `<p class="empty-state">${emptyMessage}</p>`;
}

function renderDistrict(id) {
  const district = getDistrict(id);
  if (!district) return;

  const incumbents = district.candidates.filter((candidate) => candidate[2]);
  const challengers = district.candidates.filter((candidate) => !candidate[2]);
  districtNumber.textContent = String(district.id).padStart(2, "0");
  districtName.textContent = district.name;
  districtAreas.textContent = district.areas.length
    ? district.areas.join("、")
    : district.label;
  incumbentCount.textContent = incumbents.length;
  challengerCount.textContent = challengers.length;
  renderCandidateList(incumbentList, incumbents, "本區沒有現任議員登記參選");
  renderCandidateList(challengerList, challengers, "本區沒有新人登記參選");

  featureNodes.forEach(({ node, districtId }) => {
    const active = districtId === district.id;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.querySelectorAll("[data-district]").forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.district) === district.id);
  });
}

function activeDistrictId() {
  return state.hoverDistrict || state.selectedDistrict;
}

function setHover(id) {
  state.hoverDistrict = id;
  renderDistrict(activeDistrictId());
}

function clearHover() {
  state.hoverDistrict = null;
  renderDistrict(state.selectedDistrict);
}

function selectDistrict(id) {
  state.selectedDistrict = Number(id);
  state.hoverDistrict = null;
  renderDistrict(state.selectedDistrict);
}

function allCoordinates(geometry) {
  return geometry.coordinates.flat(geometry.type === "MultiPolygon" ? 2 : 1);
}

function buildProjection(features, width, height) {
  const points = features.flatMap((feature) => allCoordinates(feature.geometry));
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  const padding = 24;
  const scale = Math.min(
    (width - padding * 2) / (maxX - minX),
    (height - padding * 2) / (maxY - minY)
  );
  const mapWidth = (maxX - minX) * scale;
  const mapHeight = (maxY - minY) * scale;
  const offsetX = (width - mapWidth) / 2;
  const offsetY = (height - mapHeight) / 2;
  return ([x, y]) => [
    offsetX + (x - minX) * scale,
    offsetY + (maxY - y) * scale
  ];
}

function ringPath(ring, project) {
  return ring
    .map((point, index) => {
      const [x, y] = project(point);
      return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ") + " Z";
}

function geometryPath(geometry, project) {
  const polygons = geometry.type === "MultiPolygon"
    ? geometry.coordinates
    : [geometry.coordinates];
  return polygons
    .flatMap((polygon) => polygon.map((ring) => ringPath(ring, project)))
    .join(" ");
}

function featureCenter(feature, project) {
  const points = allCoordinates(feature.geometry);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return project([
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2
  ]);
}

function addSvgElement(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function districtCenter(district, features, project) {
  const centers = district.areas
    .map((area) => features.find((feature) => feature.properties.TOWNNAME === area))
    .filter(Boolean)
    .map((feature) => featureCenter(feature, project));
  return [
    centers.reduce((sum, point) => sum + point[0], 0) / centers.length,
    centers.reduce((sum, point) => sum + point[1], 0) / centers.length
  ];
}

async function renderMap() {
  try {
    const response = await fetch("./data/maps/new-taipei-districts.geojson");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const geojson = await response.json();
    const width = 680;
    const height = 610;
    const project = buildProjection(geojson.features, width, height);

    svg = addSvgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "group",
      "aria-label": "新北市區域議員選舉區地圖"
    });

    geojson.features.forEach((feature) => {
      const area = feature.properties.TOWNNAME;
      const district = getDistrictForArea(area);
      if (!district) return;
      const path = addSvgElement("path", {
        d: geometryPath(feature.geometry, project),
        class: `map-area district-${district.id}`,
        tabindex: "0",
        role: "button",
        "aria-label": `${area}，${district.name}`,
        "aria-pressed": "false",
        "data-district": district.id,
        "data-area": area
      });
      path.addEventListener("mouseenter", () => setHover(district.id));
      path.addEventListener("mouseleave", clearHover);
      path.addEventListener("focus", () => setHover(district.id));
      path.addEventListener("blur", clearHover);
      path.addEventListener("mousedown", (event) => event.preventDefault());
      path.addEventListener("click", () => selectDistrict(district.id));
      path.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectDistrict(district.id);
        }
      });
      svg.append(path);
      featureNodes.push({ node: path, districtId: district.id });
    });

    election.districts.filter((district) => district.areas.length).forEach((district) => {
      const [x, y] = districtCenter(district, geojson.features, project);
      const label = addSvgElement("g", {
        class: "map-label",
        transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})`,
        "data-district": district.id,
        "aria-hidden": "true"
      });
      const circle = addSvgElement("circle", { r: "13" });
      const text = addSvgElement("text", { y: "4" });
      text.textContent = district.id;
      label.append(circle, text);
      label.addEventListener("mouseenter", () => setHover(district.id));
      label.addEventListener("mouseleave", clearHover);
      label.addEventListener("click", () => selectDistrict(district.id));
      svg.append(label);
    });

    mapCanvas.replaceChildren(svg);
    renderDistrict(state.selectedDistrict);
  } catch (error) {
    mapCanvas.innerHTML = `<p class="map-error">地圖載入失敗：${error.message}</p>`;
  }
}

document.querySelectorAll(".indigenous-buttons button").forEach((button) => {
  const id = Number(button.dataset.district);
  button.addEventListener("mouseenter", () => setHover(id));
  button.addEventListener("mouseleave", clearHover);
  button.addEventListener("focus", () => setHover(id));
  button.addEventListener("blur", clearHover);
  button.addEventListener("click", () => selectDistrict(id));
});

renderDistrict(state.selectedDistrict);
renderMap();
