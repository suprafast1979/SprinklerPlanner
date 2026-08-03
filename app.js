const APP_VERSION = 18;
const $=id=>document.getElementById(id), setStatus=t=>$('status').textContent=t;
const map=L.map('map',{maxZoom:22, zoomControl:true}).setView([44.05,-123.1],17);
const street=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  maxZoom:22, maxNativeZoom:19, attribution:'&copy; OpenStreetMap'
});
const imagery=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
  maxZoom:22, maxNativeZoom:19, attribution:'Tiles &copy; Esri'
}).addTo(map);
L.control.layers({Satellite:imagery, Streets:street}).addTo(map);

// ============================================================
// CLOUD CONFIG – paste your Supabase values here
// Leave blank to stay fully offline / localStorage only
// ============================================================
const SUPABASE_URL = 'https://rdipkufbaakfeqvqkcai.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkaXBrdWZiYWFrZmVxdnFrY2FpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1NDA1OTMsImV4cCI6MjEwMTExNjU5M30.7rCoja-zBijMk2TBT08v1_JwtGzQSUPo3Sg4IWExl-E';

let supabaseClient = null;
let currentUser = null;
let cloudEnabled = false;

const STORE='sprinklerPlannerV5';
let followUser=true,centerOnNextFix=true,userMovedMap=false,currentMode='planner',deployIndex=0,deployed=new Set(),deployZone=null,lastSpokenDistance=null;
// Desktop drawing modes: 'none' | 'click' (sequential points) | 'freehand'
let drawMode='none', freehandDrawing=false, freehandPoints=[];
const uid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);
const ftToM=ft=>Number(ft)*.3048, mToFt=m=>m/.3048;
function dist(a,b){const R=6371000,p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180,dp=(b.lat-a.lat)*Math.PI/180,dl=(b.lng-a.lng)*Math.PI/180,h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function localXY(p,o){const R=6371000,c=Math.cos(o.lat*Math.PI/180);return{x:(p.lng-o.lng)*Math.PI/180*R*c,y:(p.lat-o.lat)*Math.PI/180*R}}
function ll(p,o){const R=6371000,c=Math.cos(o.lat*Math.PI/180);return{lat:o.lat+p.y/R*180/Math.PI,lng:o.lng+p.x/(R*c)*180/Math.PI}}
function pip(p,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if(((a.y>p.y)!=(b.y>p.y))&&p.x<(b.x-a.x)*(p.y-a.y)/((b.y-a.y)||1e-9)+a.x)inside=!inside}return inside}
function area(points){if(points.length<3)return 0;const o=points[0],q=points.map(p=>localXY(p,o));let a=0;for(let i=0,j=q.length-1;i<q.length;j=i++)a+=q[j].x*q[i].y-q[i].x*q[j].y;return Math.abs(a/2)}
function chaikin(points,it=2){if(points.length<3)return points.slice();let out=points.slice();for(let k=0;k<it;k++){const n=[];for(let i=0;i<out.length;i++){const a=out[i],b=out[(i+1)%out.length];n.push({lat:.75*a.lat+.25*b.lat,lng:.75*a.lng+.25*b.lng},{lat:.25*a.lat+.75*b.lat,lng:.25*a.lng+.75*b.lng})}out=n}return out}
function centroid(points){const o=points[0],q=points.map(p=>localXY(p,o));return ll({x:q.reduce((s,p)=>s+p.x,0)/q.length,y:q.reduce((s,p)=>s+p.y,0)/q.length},o)}

let state={version:9,activeProjectId:null,activeZoneId:null,projects:[],inventory:[]};
let boundary=[],smooth=[],noSpray=[],sprinklers=[],currentAvoid=[];
let walking=false,paused=false,drawingAvoid=false,editMode=false,addVertexMode=false,removeVertexMode=false;
let watchId=null,currentPosition=null,gpsSamples=[];
let poorFixStart=null; // timestamp when accuracy first went bad while walking
let userMarker,accuracyCircle,boundaryLine,boundaryPoly,currentAvoidLine;
let avoidLayers=[],vertexMarkers=[],sprinklerLayers=[];

function defaultState(){const p={id:uid(),name:'Home',zones:[]};return{version:9,activeProjectId:p.id,activeZoneId:null,projects:[p],inventory:[{id:uid(),name:'Generic impact',qty:4,pattern:'circle',radius:35,angle:360,length:0,width:0}]}}

// ---------- Cloud / Auth helpers ----------
function initCloud(){
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY || typeof supabase === 'undefined'){
    cloudEnabled = false;
    updateAuthUI();
    return;
  }
  try{
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    cloudEnabled = true;
    supabaseClient.auth.getSession().then(({data})=>{
      currentUser = data.session?.user || null;
      updateAuthUI();
      if(currentUser) loadProjectsFromCloud();
    });
    supabaseClient.auth.onAuthStateChange((event, session)=>{
      currentUser = session?.user || null;
      updateAuthUI();
      if(event === 'SIGNED_IN' && currentUser){
        setStatus('Signed in – loading your projects…');
        loadProjectsFromCloud();
      }
      if(event === 'SIGNED_OUT'){
        setStatus('Signed out – using local projects');
      }
    });
  }catch(e){
    console.warn('Supabase init failed', e);
    cloudEnabled = false;
    updateAuthUI();
  }
}

function updateAuthUI(){
  const btn = $('authBtn');
  const label = $('authLabel');
  if(!btn) return;
  if(!cloudEnabled){
    btn.classList.add('hidden');
    if(label) label.textContent = '';
    return;
  }
  btn.classList.remove('hidden');
  if(currentUser){
    btn.textContent = 'Sign out';
    if(label) label.textContent = currentUser.email || 'Signed in';
  } else {
    btn.textContent = 'Sign in';
    if(label) label.textContent = 'Local mode';
  }
}

async function signIn(){
  if(!supabaseClient) return;
  // Prefer magic link (email). Google can be enabled in Supabase dashboard.
  const email = prompt('Enter your email for a sign-in link:');
  if(!email) return;
  const {error} = await supabaseClient.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: window.location.origin + window.location.pathname }
  });
  if(error) setStatus('Sign-in error: ' + error.message);
  else setStatus('Check your email for the sign-in link');
}

async function signOut(){
  if(!supabaseClient) return;
  await supabaseClient.auth.signOut();
  currentUser = null;
  updateAuthUI();
}

async function loadProjectsFromCloud(){
  if(!supabaseClient || !currentUser) return;
  try{
    const {data, error} = await supabaseClient
      .from('projects')
      .select('id, name, data, updated_at')
      .order('updated_at', {ascending:false});
    if(error) throw error;
    if(data && data.length){
      // Convert cloud rows into the local state shape
      state.projects = data.map(row => ({
        id: row.id,
        name: row.name,
        zones: (row.data && row.data.zones) ? row.data.zones : [],
        // keep any extra fields that were stored
        ...(row.data || {})
      }));
      // Ensure activeProjectId is valid
      if(!state.projects.find(p => p.id === state.activeProjectId)){
        state.activeProjectId = state.projects[0]?.id || null;
      }
      // Inventory is stored per-user in the first project or separately – for simplicity keep local inventory
      localStorage.setItem(STORE, JSON.stringify(state));
      refreshSelectors();
      setStatus(`Loaded ${data.length} project(s) from cloud`);
    } else {
      // First login – push current local projects up
      await syncAllProjectsToCloud();
      setStatus('No cloud projects yet – uploaded your local ones');
    }
  }catch(e){
    console.error(e);
    setStatus('Could not load cloud projects – using local copy');
  }
}

async function syncProjectToCloud(project){
  if(!supabaseClient || !currentUser || !project) return;
  try{
    const payload = {
      id: project.id,
      owner_id: currentUser.id,
      name: project.name || 'Untitled',
      data: {
        zones: project.zones || [],
        // store anything else useful
        inventory: state.inventory
      },
      updated_at: new Date().toISOString()
    };
    const {error} = await supabaseClient
      .from('projects')
      .upsert(payload, {onConflict: 'id'});
    if(error) throw error;
  }catch(e){
    console.warn('Cloud sync failed', e);
  }
}

async function syncAllProjectsToCloud(){
  if(!currentUser) return;
  for(const p of state.projects){
    await syncProjectToCloud(p);
  }
}

function save(){
  // Always write localStorage so offline still works
  localStorage.setItem(STORE, JSON.stringify(state));
  // If signed in, also push the active project to the cloud
  if(cloudEnabled && currentUser){
    const p = activeProject();
    if(p) syncProjectToCloud(p);
  }
}

function activeProject(){return state.projects.find(p=>p.id===state.activeProjectId)}
function activeZone(){return activeProject()?.zones.find(z=>z.id===state.activeZoneId)}
function zoneObject(){return{id:state.activeZoneId||uid(),name:$('zoneName').value.trim()||'Unnamed zone',boundary,smooth,noSpray,sprinklers:sprinklers.map(s=>({...s,layer:undefined})),updated:new Date().toISOString()}}
function loadZone(z){state.activeZoneId=z.id;boundary=(z.boundary||[]).map(p=>({...p}));smooth=(z.smooth||[]).map(p=>({...p}));noSpray=(z.noSpray||[]).map(a=>({name:a.name,points:a.points.map(p=>({...p}))}));sprinklers=(z.sprinklers||[]).map(s=>({...s}));$('zoneName').value=z.name;walking=paused=drawingAvoid=editMode=addVertexMode=removeVertexMode=false;poorFixStart=null;renderAll();hideSmartRecommendations();if(boundary.length)map.fitBounds(L.latLngBounds(displayBoundary()),{padding:[25,25]});refreshSelectors();setStatus(`Loaded ${z.name}`)}
function resetZone(){state.activeZoneId=null;boundary=[];smooth=[];noSpray=[];sprinklers=[];currentAvoid=[];$('zoneName').value='New zone';walking=paused=false;poorFixStart=null;renderAll();hideSmartRecommendations();refreshSelectors();setStatus('New blank zone')}

function displayBoundary(){return smooth.length?smooth:boundary}
function removeLayer(x){if(x&&map.hasLayer(x))map.removeLayer(x)}
function renderBoundary(){
  removeLayer(boundaryLine);removeLayer(boundaryPoly);
  vertexMarkers.forEach(removeLayer);vertexMarkers=[];
  const shown=displayBoundary();
  if(shown.length>=2)boundaryLine=L.polyline(shown,{color:'#176b3a',weight:4}).addTo(map);
  if(shown.length>=3&&!walking)boundaryPoly=L.polygon(shown,{color:'#176b3a',weight:3,fillColor:'#4fae70',fillOpacity:.18}).addTo(map);

  // Always show numbered points while recording or editing so gaps are obvious
  const showVertices = walking || editMode || addVertexMode || removeVertexMode;
  if(showVertices){
    boundary.forEach((p,i)=>{
      const m=L.marker(p,{
        draggable:editMode,
        icon:L.divIcon({
          className:'',
          html:`<div class="vertex-num">${i+1}</div>`,
          iconSize:[22,22],
          iconAnchor:[11,11]
        })
      }).addTo(map);
      if(editMode){
        m.on('drag',e=>{
          boundary[i]=e.target.getLatLng();
          smooth=[];
          renderBoundary();
          updateMetrics();
        });
      }
      vertexMarkers.push(m);
    });
  }
  updateMetrics();
}
function renderAvoid(){avoidLayers.forEach(removeLayer);avoidLayers=[];noSpray.forEach(a=>avoidLayers.push(L.polygon(a.points,{color:'#b33838',fillColor:'#d74b4b',fillOpacity:.32,weight:3}).bindTooltip(a.name).addTo(map)));removeLayer(currentAvoidLine);if(currentAvoid.length)currentAvoidLine=L.polyline(currentAvoid,{color:'#d54b4b',dashArray:'6,6',weight:3}).addTo(map);$('avoidCount').textContent=noSpray.length;$('avoidDrawing').textContent=drawingAvoid?'Yes':'No'}
function coverageLayer(s,i){
  const pos = s.position;
  const isDone = deployed.has(i);
  const labelClass = isDone ? 'sprinkler-label done' : 'sprinkler-label';
  const label = `<div>${isDone ? '✓' : (i+1)}</div>`;
  const coverColor = isDone ? '#1b9b50' : '#1976c8';
  let coverLayer;
  if(s.pattern === 'rectangle'){
    const o = pos, halfW = s.width/2, halfL = s.length/2;
    const pts = [ll({x:-halfW,y:-halfL},o), ll({x:halfW,y:-halfL},o), ll({x:halfW,y:halfL},o), ll({x:-halfW,y:halfL},o)];
    coverLayer = L.polygon(pts, {color:coverColor, fillOpacity:.14, weight:2}).addTo(map);
  } else {
    coverLayer = L.circle(pos, {radius:s.radius, color:coverColor, fillOpacity:.12, weight:2}).addTo(map);
  }
  const marker = L.marker(pos, {
    icon: L.divIcon({ className: labelClass, html: label, iconSize:[28,28], iconAnchor:[14,14] }),
    interactive: true
  }).addTo(map);
  // Tap marker to mark satisfied during deploy / any time
  marker.on('click', (ev) => {
    L.DomEvent.stopPropagation(ev);
    if(currentMode === 'deploy' || sprinklers.length){
      toggleSprinklerDone(i);
    }
  });
  return [coverLayer, marker];
}
function renderSprinklers(){
  sprinklerLayers.flat().forEach(removeLayer);
  sprinklerLayers = [];
  sprinklers.forEach((s,i) => sprinklerLayers.push(coverageLayer(s,i)));
  updateCoverage();
  updateDeployProgressUI();
}
function renderAll(){renderBoundary();renderAvoid();renderSprinklers();updateButtons()}
function updateButtons(){$('pauseWalkBtn').disabled=!walking;$('finishWalkBtn').disabled=!walking||boundary.length<3;$('pauseWalkBtn').textContent=paused?'Resume':'Pause';$('finishAvoidBtn').disabled=!drawingAvoid||currentAvoid.length<3;$('editBtn').textContent=editMode?'Done editing':'Edit points'}
function updateMetrics(){$('pointCount').textContent=boundary.length;const a=area(displayBoundary());$('areaValue').textContent=a?`${Math.round(a*10.7639).toLocaleString()} sq ft`:'—';$('activeZoneLabel').textContent=$('zoneName').value||'Unnamed'}

function refreshSelectors(){const ps=$('projectSelect');ps.innerHTML=state.projects.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');ps.value=state.activeProjectId||'';const p=activeProject();$('projectName').value=p?.name||'';const zs=$('zoneSelect');zs.innerHTML=p?.zones.length?p.zones.map(z=>`<option value="${z.id}">${z.name}</option>`).join(''):'<option value="">No saved zones</option>';if(state.activeZoneId)zs.value=state.activeZoneId;renderInventory();refreshLayoutChoices();renderStore()}
function renderInventory(){const box=$('inventoryList');box.innerHTML=state.inventory.length?'':'<p class="help">No sprinklers saved.</p>';state.inventory.forEach(item=>{const d=document.createElement('div');d.className='list-item';const desc=item.pattern==='rectangle'?`${item.length} × ${item.width} ft rectangle`:`${item.radius} ft radius${item.pattern==='sector'?`, ${item.angle}° max`:''}`;d.innerHTML=`<div><strong>${item.name} ×${item.qty}</strong><small>${desc}</small></div><button class="danger" data-id="${item.id}">Delete</button>`;d.querySelector('button').onclick=()=>{state.inventory=state.inventory.filter(x=>x.id!==item.id);save();refreshSelectors()};box.appendChild(d)})}
function refreshLayoutChoices(){const s=$('layoutSprinklerSelect');s.innerHTML=state.inventory.length?state.inventory.map(x=>`<option value="${x.id}">${x.name} ×${x.qty}</option>`).join(''):'<option value="">Add a sprinkler first</option>'}

// ========== STORE CATALOG ==========
const STORE_CATALOG = [
  { id:'orbit-zinc', name:'Orbit Zinc Impact', emoji:'💧', visual:'impact', pattern:'circle', radius:40, angle:360, length:0, width:0,
    desc:'Classic metal impact head. Adjustable arc, ~20–40 ft throw. Great all-around yard sprinkler.',
    query:'Orbit zinc impact sprinkler' },
  { id:'rainbird-impact', name:'Rain Bird Impact', emoji:'🌧️', visual:'impact', pattern:'circle', radius:35, angle:360, length:0, width:0,
    desc:'Durable plastic/metal impact sprinkler. Reliable full- or part-circle coverage.',
    query:'Rain Bird impact sprinkler portable' },
  { id:'orbit-watermaster', name:'Orbit WaterMaster Impulse', emoji:'⚙️', visual:'impact', pattern:'circle', radius:45, angle:360, length:0, width:0,
    desc:'Heavy-duty impulse sprinkler for larger lawns. Longer throw radius.',
    query:'Orbit WaterMaster impulse sprinkler' },
  { id:'melnor-xt', name:'Melnor XT Turbo Oscillating', emoji:'↔️', visual:'oscillating', pattern:'rectangle', radius:0, angle:360, length:60, width:35,
    desc:'Oscillating sprinkler for rectangular lawns. Width/length adjustable.',
    query:'Melnor XT Turbo oscillating sprinkler' },
  { id:'melnor-metal', name:'Melnor Metal Oscillating', emoji:'📏', visual:'oscillating', pattern:'rectangle', radius:0, angle:360, length:55, width:30,
    desc:'Metal-base oscillating sprinkler. Stable and good for medium rectangular zones.',
    query:'Melnor metal oscillating sprinkler' },
  { id:'nelson-raintrain', name:'Nelson RainTrain Traveling', emoji:'🚜', visual:'traveling', pattern:'rectangle', radius:0, angle:360, length:70, width:40,
    desc:'Traveling sprinkler that walks a path while watering. Ideal for long rectangular areas.',
    query:'Nelson RainTrain traveling sprinkler' },
  { id:'gilmour-circular', name:'Gilmour Circular Pattern', emoji:'⭕', visual:'rotary', pattern:'circle', radius:30, angle:360, length:0, width:0,
    desc:'Simple circular pattern sprinkler. Easy setup for smaller round areas.',
    query:'Gilmour circular pattern sprinkler' },
  { id:'dramm-colorstorm', name:'Dramm ColorStorm Revolving', emoji:'🌀', visual:'rotary', pattern:'circle', radius:25, angle:360, length:0, width:0,
    desc:'Revolving head with even spray. Good for flower beds and smaller lawns.',
    query:'Dramm ColorStorm revolving sprinkler' },
  { id:'aquajoe-iris', name:'Aqua Joe Indestructible Metal', emoji:'🛡️', visual:'impact', pattern:'circle', radius:50, angle:360, length:0, width:0,
    desc:'All-metal construction, large coverage. Built for durability.',
    query:'Aqua Joe AJ-IRIS indestructible metal sprinkler' },
  { id:'rainbird-rotor-port', name:'Rain Bird Portable Rotor', emoji:'🔄', visual:'rotary', pattern:'circle', radius:35, angle:360, length:0, width:0,
    desc:'Gear-driven rotor style on a portable base. Quiet and efficient.',
    query:'Rain Bird portable rotor sprinkler' }
];

let selectedStoreProduct = null;

function retailerLinksFor(query){
  const q = encodeURIComponent(query);
  return [
    { name:'Amazon', subtitle:'Usually widest selection', url:`https://www.amazon.com/s?k=${q}` },
    { name:"Lowe's", subtitle:'In-store pickup available', url:`https://www.lowes.com/search?searchTerm=${q}` },
    { name:'Home Depot', subtitle:'In-store pickup available', url:`https://www.homedepot.com/s/${q}` },
    { name:"Jerry's Home Improvement", subtitle:'Eugene / Springfield local', url:`https://www.google.com/search?q=${encodeURIComponent(query + " site:betterheadforjerrys.com OR Jerry's Home Improvement Eugene sprinkler")}` },
    { name:'Walmart', subtitle:'Often lowest price', url:`https://www.walmart.com/search?q=${q}` },
    { name:'Tractor Supply', subtitle:'Good for rural / bulk', url:`https://www.tractorsupply.com/tsc/search/${q}` }
  ];
}

function renderStore(){
  const grid = $('storeGrid');
  if(!grid) return;
  grid.innerHTML = STORE_CATALOG.map(p => `
    <button type="button" class="store-card" data-id="${p.id}">
      <div class="store-visual ${p.visual}">${p.emoji}</div>
      <strong>${p.name}</strong>
      <small>${p.pattern==='rectangle' ? `${p.length}×${p.width} ft` : `${p.radius} ft radius`}</small>
    </button>
  `).join('');
  grid.querySelectorAll('.store-card').forEach(btn => {
    btn.onclick = () => openStoreProduct(btn.dataset.id);
  });
}

function openStoreProduct(id){
  const p = STORE_CATALOG.find(x => x.id === id);
  if(!p) return;
  selectedStoreProduct = p;
  const modal = $('storeModal');
  if(!modal) return;
  $('storeModalVisual').className = `store-visual large ${p.visual}`;
  $('storeModalVisual').textContent = p.emoji;
  $('storeModalTitle').textContent = p.name;
  $('storeModalDesc').textContent = p.desc + (p.pattern==='rectangle'
    ? ` Coverage about ${p.length} × ${p.width} ft.`
    : ` Typical throw about ${p.radius} ft.`);
  const box = $('storeRetailerLinks');
  box.innerHTML = retailerLinksFor(p.query).map(r =>
    `<a class="rec-link" href="${r.url}" target="_blank" rel="noopener noreferrer">${r.name}<small>${r.subtitle}</small></a>`
  ).join('');
  modal.classList.remove('hidden');
}

function closeStoreModal(){
  $('storeModal')?.classList.add('hidden');
  selectedStoreProduct = null;
}

function addStoreProductToInventory(){
  if(!selectedStoreProduct) return;
  const p = selectedStoreProduct;
  state.inventory.push({
    id: uid(),
    name: p.name,
    qty: 1,
    pattern: p.pattern,
    radius: p.radius || 35,
    angle: p.angle || 360,
    length: p.length || 50,
    width: p.width || 30
  });
  save();
  refreshSelectors();
  setStatus(`Added “${p.name}” to inventory`);
  closeStoreModal();
}

function vibrateAlert(){
  if(navigator.vibrate){
    navigator.vibrate([200,100,200,100,400]); // distinct pattern
  }
}

function startGPS(center=false){
  if(!navigator.geolocation)return setStatus('Geolocation unavailable');
  if(center){centerOnNextFix=true;followUser=true;userMovedMap=false;$('resumeFollowBtn').classList.add('hidden')}
  if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}
  watchId=navigator.geolocation.watchPosition(handleGPS,err=>{
    setStatus(err.code===1?'Location permission is needed to center the map':`GPS: ${err.message}`)
  },{enableHighAccuracy:true,maximumAge:0,timeout:12000})
  if(center&&currentPosition)centerMapOnUser();
}
function centerMapOnUser(){if(!currentPosition)return;map.setView(currentPosition, Math.min(20, map.getZoom() < 18 ? 19 : map.getZoom()));centerOnNextFix=false;followUser=true;userMovedMap=false;$('resumeFollowBtn').classList.add('hidden')}
function handleGPS(pos){
  const p={lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy,t:pos.timestamp};currentPosition=p;
  const accFt=Math.round(mToFt(p.accuracy));
  $('accuracy').textContent=`±${accFt} ft`;
  $('accuracy').style.color=accFt<=12?'#1b9b50':accFt<=25?'#c98a00':'#a93636';

  if(!userMarker){userMarker=L.circleMarker(p,{radius:7,color:'#fff',weight:2,fillColor:'#1b9b50',fillOpacity:1}).addTo(map);accuracyCircle=L.circle(p,{radius:p.accuracy,color:'#1b9b50',weight:1,fillOpacity:.08}).addTo(map)}else{userMarker.setLatLng(p);accuracyCircle.setLatLng(p).setRadius(p.accuracy)}

  if(centerOnNextFix){centerMapOnUser();selectNearestDeployZone();setStatus('Location found')}
  else if(followUser&&currentMode==='deploy')map.panTo(p,{animate:true,duration:.35});

  gpsSamples.push(p);
  gpsSamples=gpsSamples.filter(x=>p.t-x.t<12000).slice(-15);

  // Auto-pause logic while walking
  const limit=Number($('accuracyLimit').value);
  if(walking && !paused){
    if(p.accuracy > limit){
      if(!poorFixStart) poorFixStart = p.t;
      // If poor accuracy has lasted > 3.5 seconds → pause + alert
      if(p.t - poorFixStart > 3500){
        paused = true;
        updateButtons();
        vibrateAlert();
        const last = boundary.at(-1);
        if(last){
          map.panTo(last, {animate:true, duration:0.6});
          const feet = Math.round(mToFt(dist(p, last)));
          const dir = compassDirection(p, last);
          setStatus(`GPS weak — STOP. Walk ${dir} ${feet} ft back to point ${boundary.length}. Wait for green accuracy, then Resume.`);
        } else {
          setStatus('GPS weak — STOP walking. Wait for green accuracy, then Resume.');
        }
        poorFixStart = null;
      }
    } else {
      poorFixStart = null; // good fix resets the timer
      if(walking && !paused) maybeRecordGPS(p);
    }
  } else if(walking && paused){
    // Live guidance back to the last good point while paused
    const last = boundary.at(-1);
    if(last && currentPosition){
      const feet = Math.round(mToFt(dist(currentPosition, last)));
      const dir = compassDirection(currentPosition, last);
      const accFt = Math.round(mToFt(currentPosition.accuracy));
      if(feet <= 8 && accFt <= limit * 3.28084){ // roughly within 8 ft and acceptable accuracy
        setStatus(`Back at point ${boundary.length}. Accuracy ±${accFt} ft — tap Resume when ready.`);
      } else if(feet <= 8){
        setStatus(`Near point ${boundary.length}. Hold still for better accuracy (±${accFt} ft), then Resume.`);
      } else {
        setStatus(`Walk ${dir} ${feet} ft back to point ${boundary.length}. (Accuracy ±${accFt} ft)`);
      }
    }
  } else {
    if(walking && !paused) maybeRecordGPS(p);
  }

  updateDeployGuidance();
}
function averagedFix(){
  const limit=Number($('accuracyLimit').value);
  const good=gpsSamples.filter(p=>p.accuracy<=limit);
  if(good.length < 3) return null; // require 3 solid samples
  let w=0,lat=0,lng=0;
  good.forEach(p=>{
    const q=1/Math.max(1,p.accuracy*p.accuracy);
    w+=q; lat+=p.lat*q; lng+=p.lng*q;
  });
  return {lat:lat/w, lng:lng/w, accuracy:Math.min(...good.map(p=>p.accuracy))};
}
function maybeRecordGPS(p){
  const limit=Number($('accuracyLimit').value);
  if(p.accuracy > limit) return;
  const q=averagedFix();
  if(!q) return;
  const last=boundary.at(-1);
  if(last){
    const d=dist(last,q);
    // Require meaningful but not crazy movement
    if(d < 2.8) return;          // too close – ignore
    if(d > 14 && p.accuracy > 4) return; // big jump with only mediocre accuracy – reject
  }
  boundary.push({lat:q.lat,lng:q.lng});
  smooth=[];
  renderBoundary();
  setStatus(`Recording • ${boundary.length} points`);
}
function addAveragedPoint(){
  startGPS(false);
  const q=averagedFix();
  if(!q) return setStatus('Waiting for a solid GPS fix (need 3 good readings)');
  boundary.push({lat:q.lat,lng:q.lng});
  smooth=[];
  renderBoundary();
  setStatus('Averaged GPS point added');
}

function pointCovered(q,s){const p=localXY(q,s.position);if(s.pattern==='rectangle')return Math.abs(p.x)<=s.width/2&&Math.abs(p.y)<=s.length/2;return Math.hypot(p.x,p.y)<=s.radius}
function sampleCoverage(){const zone=displayBoundary();if(zone.length<3||!sprinklers.length)return null;const o=zone[0],poly=zone.map(p=>localXY(p,o)),avoids=noSpray.map(a=>a.points.map(p=>localXY(p,o)));const xs=poly.map(p=>p.x),ys=poly.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);const step=Math.max(0.8,Math.min(2.2,Math.sqrt(area(zone))/120));let eligible=0,covered=0,multi=0,overspray=0,outside=0;for(let y=minY-step*2;y<=maxY+step*2;y+=step)for(let x=minX-step*2;x<=maxX+step*2;x+=step){const inside=pip({x,y},poly)&&!avoids.some(a=>pip({x,y},a));const q=ll({x,y},o);const count=sprinklers.reduce((n,s)=>n+(pointCovered(q,s)?1:0),0);if(inside){eligible++;if(count){covered++;if(count>1)multi++}}else if(count){outside++;overspray++}}return{coverage:eligible?covered/eligible*100:0,uncoveredSqFt:(eligible-covered)*step*step*10.7639,overlap:covered?multi/covered*100:0,overspray:outside?overspray/(outside+eligible)*100:0}}
function updateCoverage(){
  const r=sampleCoverage();
  $('sprinklerCount').textContent=sprinklers.length;
  if(!r){
    ['coverageValue','uncoveredValue','oversprayValue','overlapValue'].forEach(id=>$(id).textContent='—');
    $('recommendValue').textContent='—';
    hideSmartRecommendations();
    return;
  }
  $('coverageValue').textContent=`${r.coverage.toFixed(1)}%`;
  $('uncoveredValue').textContent=`${Math.round(r.uncoveredSqFt)} sq ft`;
  $('oversprayValue').textContent=`${r.overspray.toFixed(1)}%`;
  $('overlapValue').textContent=`${r.overlap.toFixed(0)}%`;
  $('recommendValue').textContent=r.coverage>=99?'Good':r.coverage>=95?'Minor adjustment':'Add or reposition';
}

// Minimum distance from point p to polygon (local XY coords). 0 if inside.
function minDistToPoly(p, poly){
  if(pip(p, poly)) return 0;
  let minD = Infinity;
  for(let i=0, j=poly.length-1; i<poly.length; j=i++){
    const a = poly[j], b = poly[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx*dx + dy*dy || 1e-12;
    let t = ((p.x-a.x)*dx + (p.y-a.y)*dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const proj = {x: a.x + t*dx, y: a.y + t*dy};
    const d = Math.hypot(p.x - proj.x, p.y - proj.y);
    if(d < minD) minD = d;
  }
  return minD;
}

// Station centers must sit in the green zone and never inside a no-spray area.
// Spray may graze no-spray at the edge — full zone coverage comes first.
// (You sequence stations later based on well capacity / how many heads you own.)
function candidateAllowed(q, o, poly, avoids, item){
  const p = localXY(q, o);
  if(!pip(p, poly)) return false;
  if(avoids.some(a => pip(p, a))) return false;
  return true;
}

function hideSmartRecommendations(){
  const panel=$('smartRecPanel');
  if(panel) panel.classList.add('hidden');
}

function buildSmartRecommendations(r, item){
  if(!r || !item || r.coverage >= 98) return null;

  const zoneAreaSqFt = area(displayBoundary()) * 10.7639;
  const radiusFt = Number(item.radius) || 35;
  const pattern = item.pattern || 'circle';
  const owned = Number(item.qty) || 0;
  const placed = sprinklers.length;
  const uncovered = r.uncoveredSqFt;
  const gapPct = (100 - r.coverage).toFixed(1);

  // Estimate extra units needed from actual performance of the current layout
  let extraNeeded = 1;
  if(placed > 0){
    const avgCoveredPer = (zoneAreaSqFt * (r.coverage/100)) / placed;
    extraNeeded = Math.ceil(uncovered / Math.max(avgCoveredPer * 0.82, 180));
  } else {
    const nominalArea = Math.PI * radiusFt * radiusFt * 0.55;
    extraNeeded = Math.ceil(uncovered / Math.max(nominalArea, 200));
  }
  extraNeeded = Math.max(1, Math.min(extraNeeded, 14));

  const reasons = [];
  reasons.push(`You own ${owned} × “${item.name}”. The optimizer used all of them.`);
  reasons.push(`≈ ${Math.round(uncovered).toLocaleString()} sq ft remains dry (${gapPct}% of the zone).`);
  if(extraNeeded >= 1){
    reasons.push(`About ${extraNeeded} more unit${extraNeeded===1?'':'s'} of similar capacity would close most of the gap.`);
  }
  if(r.overspray > 12){
    reasons.push(`Current placement has noticeable overspray (${r.overspray.toFixed(0)}%). A different pattern or tighter spacing may help.`);
  }

  // Build 5 targeted product suggestions
  const links = [];

  // 1. More of the same type
  links.push({
    title: `More “${item.name}” (or equivalent)`,
    subtitle: `Buy ~${extraNeeded} more • same ${radiusFt} ft class`,
    query: `${item.name} ${radiusFt} ft radius sprinkler portable`
  });

  // 2. Larger / better impact
  if(radiusFt < 42){
    links.push({
      title: 'Larger-radius impact sprinkler (40–50 ft)',
      subtitle: 'Fewer heads needed for the same area',
      query: 'impact sprinkler 40 ft 50 ft radius metal brass'
    });
  } else {
    links.push({
      title: 'Heavy-duty brass impact sprinkler',
      subtitle: 'Durable head for consistent long throws',
      query: 'brass impact sprinkler heavy duty full circle'
    });
  }

  // 3. Pattern alternative
  if(pattern === 'rectangle'){
    links.push({
      title: 'Full-circle or adjustable impact sprinkler',
      subtitle: 'Better for open or irregular lawn shapes',
      query: 'impact sprinkler adjustable arc full circle portable'
    });
  } else {
    links.push({
      title: 'Oscillating rectangular sprinkler',
      subtitle: 'Excellent for long or rectangular zones',
      query: 'oscillating sprinkler large coverage area metal'
    });
  }

  // 4. Popular reliable brands
  links.push({
    title: 'Orbit / Rain Bird / Nelson portable',
    subtitle: 'Highly rated, easy-to-find models',
    query: 'Orbit impact sprinkler OR Rain Bird sprinkler OR Nelson sprinkler portable'
  });

  // 5. Current best overall
  links.push({
    title: 'Best portable sprinklers for large yards',
    subtitle: 'Top-rated current options',
    query: 'best portable lawn sprinkler large yard high coverage'
  });

  const title = r.coverage < 75 ? 'Significant coverage gap' :
                r.coverage < 90 ? 'Coverage needs improvement' :
                'Almost there — small gap remains';

  const summary = `Your current inventory reaches ${r.coverage.toFixed(1)}% coverage. ` +
    `Adding roughly ${extraNeeded} more similar sprinkler${extraNeeded===1?'':'s'} ` +
    `(or a few higher-capacity units) would get this zone close to full coverage.`;

  return { title, summary, reasons, links };
}

function renderSmartRecommendations(data){
  const panel = $('smartRecPanel');
  if(!panel) return;
  if(!data){
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  $('recTitle').textContent = data.title;
  $('recSummary').textContent = data.summary;

  const ul = $('recReasons');
  ul.innerHTML = data.reasons.map(r => `<li>${r}</li>`).join('');

  const box = $('recLinks');
  box.innerHTML = data.links.map(link => {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(link.query)}`;
    return `<a class="rec-link" href="${url}" target="_blank" rel="noopener noreferrer">
      ${link.title}
      <small>${link.subtitle}</small>
    </a>`;
  }).join('');
}

function makeSprinkler(item, q){
  return {
    inventoryId: item.id,
    name: item.name,
    pattern: item.pattern,
    position: q,
    radius: ftToM(item.radius || 0),
    angle: item.angle || 360,
    length: ftToM(item.length || 0),
    width: ftToM(item.width || 0)
  };
}

// Grid + gap-fill so the whole zone gets wet (~100% with overlap).
function generateLayout(){
  const zone = displayBoundary();
  const item = state.inventory.find(x => x.id === $('layoutSprinklerSelect').value);
  if(zone.length < 3) return setStatus('Finish a zone boundary first');
  if(!item) return setStatus('Add a sprinkler to inventory first');

  sprinklers = [];
  const o = zone[0];
  const poly = zone.map(p => localXY(p, o));
  const avoids = noSpray.map(a => a.points.map(p => localXY(p, o)));
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const mode = $('priority').value;

  // Tighter spacing = continuous coverage with overlap
  // coverage: ~0.9× radius (strong overlap)
  // balanced: 1.0× radius (classic head-to-head)
  // water: 1.25× radius (still continuous, less overlap)
  let sx, sy;
  if(item.pattern === 'rectangle'){
    const f = mode === 'water' ? 0.85 : mode === 'coverage' ? 0.55 : 0.7;
    sx = Math.max(ftToM(item.width || 30) * f, 1);
    sy = Math.max(ftToM(item.length || 50) * f, 1);
  } else {
    const r = ftToM(item.radius || 35);
    const f = mode === 'water' ? 1.25 : mode === 'coverage' ? 0.9 : 1.0;
    sx = Math.max(r * f, 1);
    sy = sx * 0.866; // hexagonal stagger
  }

  const max = $('inventoryOnly').checked ? item.qty : 500;
  let row = 0;
  for(let y = minY; y <= maxY && sprinklers.length < max; y += sy){
    const off = (row++ % 2) * (sx / 2);
    for(let x = minX + off; x <= maxX && sprinklers.length < max; x += sx){
      const q = ll({x, y}, o);
      if(!candidateAllowed(q, o, poly, avoids, item)) continue;
      if(sprinklers.some(s => dist(s.position, q) < sx * 0.45)) continue;
      sprinklers.push(makeSprinkler(item, q));
    }
  }

  // Gap-fill: keep adding stations on dry ground until ~full coverage.
  // Inventory only limits how many you RUN at once — not how many stations exist.
  if(!$('inventoryOnly').checked || sprinklers.length < max){
    const step = Math.max(Math.min(sx * 0.25, 2.5), 0.8);
    const minSep = Math.max(sx * 0.35, 1.0);
    let guard = 0;
    while(sprinklers.length < max && guard++ < 200){
      const cov = sampleCoverage();
      if(cov && cov.coverage >= 99.2) break;

      let best = null;
      // Prefer boundary vertices that are still dry (catches thin arms / corners)
      for(const v of poly){
        const q = ll(v, o);
        if(!candidateAllowed(q, o, poly, avoids, item)) continue;
        if(sprinklers.some(s => dist(s.position, q) < minSep)) continue;
        if(sprinklers.some(s => pointCovered(q, s))) continue;
        best = q;
        break;
      }
      if(!best){
        for(let y = minY; y <= maxY; y += step){
          for(let x = minX; x <= maxX; x += step){
            const p = {x, y};
            if(!pip(p, poly)) continue;
            if(avoids.some(a => pip(p, a))) continue;
            const q = ll(p, o);
            if(!candidateAllowed(q, o, poly, avoids, item)) continue;
            if(sprinklers.some(s => dist(s.position, q) < minSep)) continue;
            if(sprinklers.some(s => pointCovered(q, s))) continue;
            best = q;
            break;
          }
          if(best) break;
        }
      }
      if(!best) break;
      sprinklers.push(makeSprinkler(item, best));
    }
  }

  if(!sprinklers.length){
    const c = centroid(zone);
    if(candidateAllowed(c, o, poly, avoids, item)){
      sprinklers.push(makeSprinkler(item, c));
    }
  }

  renderSprinklers();
  const r = sampleCoverage();

  if(r){
    if(r.coverage >= 99) $('recommendValue').textContent = 'Full coverage';
    else if(r.coverage >= 95) $('recommendValue').textContent = 'Nearly full';
    else if($('inventoryOnly').checked && sprinklers.length >= item.qty)
      $('recommendValue').textContent = 'Need more units';
    else $('recommendValue').textContent = 'Still filling gaps';
  }

  if(r && $('inventoryOnly').checked && r.coverage < 98 && sprinklers.length >= item.qty){
    const smart = buildSmartRecommendations(r, item);
    renderSmartRecommendations(smart);
  } else {
    hideSmartRecommendations();
  }

  const covTxt = r ? ` • ${r.coverage.toFixed(1)}% coverage` : '';
  setStatus(`Placed ${sprinklers.length} station${sprinklers.length === 1 ? '' : 's'}${covTxt}`);
}


function allSavedZones(){
  const out=[];
  state.projects.forEach(p=>(p.zones||[]).forEach(z=>out.push({project:p,zone:z})));
  return out;
}
function zoneCenter(z){const pts=(z.smooth?.length?z.smooth:z.boundary)||[];return pts.length?centroid(pts):null}
function refreshDeployChoices(){
  const zones=allSavedZones(),sel=$('deployZoneSelect');
  sel.innerHTML=zones.length?zones.map(({project,zone})=>`<option value="${project.id}|${zone.id}">${project.name} — ${zone.name}</option>`).join(''):'<option value="">No saved zones</option>';
}
function selectNearestDeployZone(){
  refreshDeployChoices(); if(!currentPosition)return;
  let best=null,bestD=Infinity;
  allSavedZones().forEach(x=>{const c=zoneCenter(x.zone);if(c){const d=dist(currentPosition,c);if(d<bestD){bestD=d;best=x}}});
  if(best){$('deployZoneSelect').value=`${best.project.id}|${best.zone.id}`;$('deploySubtitle').textContent=bestD<160?`${best.zone.name} is ${Math.round(mToFt(bestD))} ft away.`:`Closest saved layout: ${best.project.name} — ${best.zone.name}`}
}
function selectedDeployZone(){
  const [pid,zid]=($('deployZoneSelect').value||'|').split('|');
  const project=state.projects.find(p=>p.id===pid); return project?{project,zone:project.zones.find(z=>z.id===zid)}:null;
}
function setMode(mode){
  currentMode=mode;
  $('plannerPanel').classList.toggle('hidden',mode!=='planner');$('deployPanel').classList.toggle('hidden',mode!=='deploy');
  $('plannerModeBtn').classList.toggle('active',mode==='planner');$('deployModeBtn').classList.toggle('active',mode==='deploy');
  if(mode==='deploy'){refreshDeployChoices();selectNearestDeployZone();followUser=true;startGPS(true)}
  setTimeout(()=>map.invalidateSize(),80);
}
function beginDeployment(resume=false){
  const chosen=selectedDeployZone();if(!chosen?.zone)return setStatus('Save a zone first');
  deployZone=chosen.zone;
  if(!deployZone.sprinklers?.length){$('deployEmpty').classList.remove('hidden');$('deployActive').classList.add('hidden');return setStatus('This zone has no saved sprinkler layout')}
  $('deployEmpty').classList.add('hidden');$('deployActive').classList.remove('hidden');
  if(!resume){deployIndex=0;deployed=new Set();}
  boundary=(deployZone.boundary||[]).map(p=>({...p}));smooth=(deployZone.smooth||[]).map(p=>({...p}));noSpray=(deployZone.noSpray||[]).map(a=>({name:a.name,points:a.points.map(p=>({...p}))}));sprinklers=(deployZone.sprinklers||[]).map(s=>({...s}));
  renderAll();showDeployTarget();startGPS(true);setStatus(`Setting up ${deployZone.name}`);
}
function speak(text){if(!$('voiceGuidance').checked||!('speechSynthesis'in window))return; speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(text))}
function showDeployTarget(){
  if(!sprinklers.length)return;
  if(deployIndex>=sprinklers.length){$('deployTitle').textContent='Setup complete';$('deployProgress').textContent=`${sprinklers.length} sprinklers placed`;$('deployDistance').textContent='Complete';$('deployDirection').textContent='All sprinkler positions have been visited.';speak('Sprinkler setup complete');return}
  $('deployTitle').textContent=deployZone?.name||'Sprinkler setup';$('deployProgress').textContent=`Sprinkler ${deployIndex+1} of ${sprinklers.length}`;
  sprinklerLayers.flat().forEach((layer,i)=>{if(layer?.getElement)layer.getElement()?.classList.toggle('deploy-target',Math.floor(i/2)===deployIndex)});
  const target=sprinklers[deployIndex]?.position;if(target)map.panTo(target);updateDeployGuidance();
}
function compassDirection(from,to){const y=Math.sin((to.lng-from.lng)*Math.PI/180)*Math.cos(to.lat*Math.PI/180),x=Math.cos(from.lat*Math.PI/180)*Math.sin(to.lat*Math.PI/180)-Math.sin(from.lat*Math.PI/180)*Math.cos(to.lat*Math.PI/180)*Math.cos((to.lng-from.lng)*Math.PI/180);const d=(Math.atan2(y,x)*180/Math.PI+360)%360;return['north','northeast','east','southeast','south','southwest','west','northwest'][Math.round(d/45)%8]}
function updateDeployGuidance(){
  if(currentMode!=='deploy'||!deployZone||deployIndex>=sprinklers.length)return;
  const target=sprinklers[deployIndex].position;if(!currentPosition){$('deployDistance').textContent='Waiting for GPS…';return}
  const feet=Math.round(mToFt(dist(currentPosition,target)));
  const accFt=Math.round(mToFt(currentPosition.accuracy));
  $('deployDistance').textContent=feet<=6?'You are here':`${feet} ft`;
  if(feet<=6){
    if(accFt<=14){$('deployDirection').textContent='Good accuracy — place the sprinkler';$('placedBtn').disabled=false}
    else{$('deployDirection').textContent=`Accuracy still ±${accFt} ft — hold still for a better fix`;$('placedBtn').disabled=true}
  }else{
    $('deployDirection').textContent=`Walk ${compassDirection(currentPosition,target)} toward the highlighted point`;
    $('placedBtn').disabled=true;
  }
  const bucket=feet<=6?0:feet<=15?Math.ceil(feet/3)*3:Math.ceil(feet/10)*10;
  if(bucket!==lastSpokenDistance&&(bucket===0||bucket<=30)){lastSpokenDistance=bucket;speak(bucket===0?(accFt<=14?'You have arrived. Place the sprinkler.':'You are here, but accuracy is still low. Hold still.'):`${feet} feet`)}
}
function nextDeploy(markPlaced){if(deployIndex>=sprinklers.length)return;if(markPlaced)deployed.add(deployIndex);deployIndex++;lastSpokenDistance=null;showDeployTarget()}

// ========== WIZARD NAVIGATION ==========
let currentWizardStep = 'project';

function goToStep(step){
  currentWizardStep = step;
  // Hide all wizard steps
  document.querySelectorAll('.wizard-step').forEach(el => el.classList.remove('active'));
  // Show target
  const mapStep = {
    project: 'stepProject',
    inventory: 'stepInventory',
    zones: 'stepZones',
    layout: 'stepLayout'
  };
  const el = $(mapStep[step]);
  if(el) el.classList.add('active');

  // Update progress indicators
  document.querySelectorAll('.wiz-step').forEach(btn => {
    btn.classList.remove('active', 'done');
    const s = btn.dataset.step;
    if(s === step) btn.classList.add('active');
    else if((s === 'project' && step !== 'project') ||
            (s === 'zones' && step === 'layout')) btn.classList.add('done');
  });

  setTimeout(() => map.invalidateSize(), 80);
  setStatus(step === 'project' ? 'Project' :
            step === 'zones' ? 'Zones – walk perimeters' :
            step === 'layout' ? 'Layout – optimize sprinklers' :
            step === 'inventory' ? 'Inventory' : '');
}

// Wizard nav buttons
if($('toZonesBtn')) $('toZonesBtn').onclick = () => goToStep('zones');
if($('backToProjectBtn')) $('backToProjectBtn').onclick = () => goToStep('project');
if($('finishZonesBtn')) $('finishZonesBtn').onclick = () => {
  // Soft prompt: if they have zones, continue; otherwise remind
  const p = activeProject();
  if(!p?.zones?.length && boundary.length < 3){
    setStatus('Save at least one zone (or finish a boundary) before continuing');
    return;
  }
  // Auto-save current zone if it has a boundary
  if(boundary.length >= 3){
    const z = zoneObject();
    const i = p.zones.findIndex(x => x.id === z.id);
    if(i >= 0) p.zones[i] = z; else p.zones.push(z);
    state.activeZoneId = z.id;
    save();
    refreshSelectors();
  }
  goToStep('layout');
};
if($('backToZonesBtn')) $('backToZonesBtn').onclick = () => goToStep('zones');
if($('goDeployBtn')) $('goDeployBtn').onclick = () => setMode('deploy');
if($('goInventoryBtn')) $('goInventoryBtn').onclick = () => goToStep('inventory');
if($('backFromInventoryBtn')) $('backFromInventoryBtn').onclick = () => goToStep('project');
if($('storeModalClose')) $('storeModalClose').onclick = closeStoreModal;
if($('storeAddInvBtn')) $('storeAddInvBtn').onclick = addStoreProductToInventory;
if($('storeModal')){
  $('storeModal').onclick = e => { if(e.target === $('storeModal')) closeStoreModal(); };
}

// Progress step clicks
document.querySelectorAll('.wiz-step').forEach(btn => {
  btn.onclick = () => goToStep(btn.dataset.step);
});

// ========== SMART SEARCH ==========
const SEARCH_INTENTS = [
  { keywords: ['project', 'projects', 'new project', 'select project'], label: 'Go to Projects', action: () => { setMode('planner'); goToStep('project'); } },
  { keywords: ['zone', 'zones', 'new zone', 'walk', 'perimeter', 'boundary', 'record'], label: 'Go to Zones', action: () => { setMode('planner'); goToStep('zones'); } },
  { keywords: ['layout', 'optimize', 'sprinkler layout', 'coverage', 'place sprinklers'], label: 'Go to Layout', action: () => { setMode('planner'); goToStep('layout'); } },
  { keywords: ['inventory', 'sprinklers i own', 'add sprinkler', 'my sprinklers'], label: 'Manage Inventory', action: () => { setMode('planner'); goToStep('inventory'); } },
  { keywords: ['deploy', 'set up', 'setup', 'field setup', 'place in field'], label: 'Go to Set Up / Deploy', action: () => setMode('deploy') },
  { keywords: ['import', 'import project'], label: 'Import a project', action: () => { setMode('planner'); goToStep('project'); setTimeout(() => $('importInput')?.click(), 200); } },
  { keywords: ['export', 'export project'], label: 'Export current project', action: () => { setMode('planner'); goToStep('project'); setTimeout(() => $('exportBtn')?.click(), 200); } },
  { keywords: ['start walking', 'start recording', 'walk perimeter'], label: 'Start walking perimeter', action: () => { setMode('planner'); goToStep('zones'); setTimeout(() => $('startWalkBtn')?.click(), 200); } },
  { keywords: ['no spray', 'no-spray', 'avoid', 'keep dry'], label: 'No-spray areas', action: () => { setMode('planner'); goToStep('zones'); } },
  { keywords: ['locate', 'my location', 'center map', 'gps'], label: 'Center map on me', action: () => startGPS(true) },
  { keywords: ['store', 'buy', 'shop', 'purchase', 'amazon', 'prices', 'retailer'], label: 'Open Store (buy sprinklers)', action: () => { setMode('planner'); goToStep('inventory'); } },
];

function openSearch(){
  $('searchOverlay')?.classList.remove('hidden');
  const input = $('searchInput');
  if(input){
    input.value = '';
    input.focus();
    renderSearchResults('');
  }
}
function closeSearch(){
  $('searchOverlay')?.classList.add('hidden');
}
function renderSearchResults(query){
  const box = $('searchResults');
  if(!box) return;
  const q = (query || '').toLowerCase().trim();
  let matches = SEARCH_INTENTS;
  if(q){
    matches = SEARCH_INTENTS.filter(intent =>
      intent.keywords.some(k => k.includes(q) || q.includes(k)) ||
      intent.label.toLowerCase().includes(q)
    );
  }
  if(!matches.length){
    box.innerHTML = '<div class="search-empty">No matching actions. Try “zones”, “layout”, “inventory”, “deploy”…</div>';
    return;
  }
  box.innerHTML = matches.map((intent, i) =>
    `<button class="search-result" data-idx="${i}">
      ${intent.label}
      <small>${intent.keywords.slice(0,3).join(' · ')}</small>
    </button>`
  ).join('');
  box.querySelectorAll('.search-result').forEach(btn => {
    btn.onclick = () => {
      const intent = matches[Number(btn.dataset.idx)];
      closeSearch();
      intent.action();
    };
  });
}

if($('searchBtn')) $('searchBtn').onclick = openSearch;
if($('closeSearchBtn')) $('closeSearchBtn').onclick = closeSearch;
if($('searchInput')){
  $('searchInput').oninput = e => renderSearchResults(e.target.value);
  $('searchInput').onkeydown = e => {
    if(e.key === 'Escape') closeSearch();
    if(e.key === 'Enter'){
      const first = $('searchResults')?.querySelector('.search-result');
      if(first) first.click();
    }
  };
}
// Close search when tapping the dimmed background
if($('searchOverlay')){
  $('searchOverlay').onclick = e => {
    if(e.target === $('searchOverlay')) closeSearch();
  };
}

// ========== EXISTING CONTROLS ==========
$('plannerModeBtn').onclick=()=>setMode('planner');
$('deployModeBtn').onclick=()=>setMode('deploy');
$('startDeployBtn').onclick=()=>beginDeployment(false);
$('resumeDeployBtn').onclick=()=>beginDeployment(true);
$('placedBtn').onclick=()=>nextDeploy(true);
$('skipBtn').onclick=()=>nextDeploy(false);
$('previousBtn').onclick=()=>{deployIndex=Math.max(0,deployIndex-1);lastSpokenDistance=null;showDeployTarget()};
$('endDeployBtn').onclick=()=>{$('deployActive').classList.add('hidden');deployZone=null;setStatus('Setup ended')};
$('deployZoneSelect').onchange=()=>{const x=selectedDeployZone();$('deployTitle').textContent=x?.zone?.name||'Choose a saved layout'};
$('floatingLocateBtn').onclick=()=>startGPS(true);
$('resumeFollowBtn').onclick=()=>startGPS(true);
$('startWalkBtn').onclick=()=>{startGPS(true);walking=true;paused=false;poorFixStart=null;boundary=[];smooth=[];sprinklers=[];renderAll();setStatus('Recording perimeter — walk slowly, keep phone skyward')};
$('pauseWalkBtn').onclick=()=>{paused=!paused;poorFixStart=null;updateButtons();setStatus(paused?'Recording paused':'Recording resumed')};
$('addPointBtn').onclick=addAveragedPoint;
$('finishWalkBtn').onclick=()=>{
  walking=false;paused=false;poorFixStart=null;
  smooth=chaikin(boundary,2);
  renderAll();
  if(boundary.length) map.fitBounds(L.latLngBounds(displayBoundary()),{padding:[25,25]});
  setStatus('Boundary finished');
  // After finishing a boundary, gently ask about another zone
  setTimeout(() => {
    if(boundary.length >= 3 && confirm('Zone boundary finished.\n\nWould you like to create another zone?')){
      // Save current then start new
      const p = activeProject();
      if(p){
        const z = zoneObject();
        const i = p.zones.findIndex(x => x.id === z.id);
        if(i >= 0) p.zones[i] = z; else p.zones.push(z);
        state.activeZoneId = z.id;
        save();
        refreshSelectors();
      }
      resetZone();
      setStatus('New zone – name it and start walking');
    }
  }, 300);
};
$('smoothBtn').onclick=()=>{if(boundary.length<3)return setStatus('Add at least 3 points');smooth=chaikin(boundary,2);renderBoundary();setStatus('Boundary display smoothed')};
$('editBtn').onclick=()=>{editMode=!editMode;addVertexMode=removeVertexMode=false;renderBoundary();updateButtons();setStatus(editMode?'Drag numbered points to adjust':'Editing finished')};
$('addVertexBtn').onclick=()=>{addVertexMode=!addVertexMode;removeVertexMode=editMode=false;renderBoundary();setStatus(addVertexMode?'Tap the map to add boundary points':'Add-point mode off')};
$('removeVertexBtn').onclick=()=>{removeVertexMode=!removeVertexMode;addVertexMode=editMode=false;renderBoundary();setStatus(removeVertexMode?'Tap near a numbered point to remove it':'Remove-point mode off')};
$('clearBoundaryBtn').onclick=resetZone;
$('drawAvoidBtn').onclick=()=>{drawingAvoid=true;currentAvoid=[];walking=false;renderAvoid();updateButtons();setStatus('Tap around the no-spray area')};
$('finishAvoidBtn').onclick=()=>{if(currentAvoid.length<3)return;noSpray.push({name:$('avoidName').value.trim()||`No-spray ${noSpray.length+1}`,points:[...currentAvoid]});currentAvoid=[];drawingAvoid=false;renderAvoid();updateCoverage();updateButtons();setStatus('No-spray area saved')};
$('deleteAvoidBtn').onclick=()=>{noSpray.pop();renderAvoid();updateCoverage()};
$('clearAvoidBtn').onclick=()=>{noSpray=[];currentAvoid=[];drawingAvoid=false;renderAvoid();updateCoverage();updateButtons()};
$('invPattern').onchange=()=>{const p=$('invPattern').value;$('invRect').classList.toggle('hidden',p!=='rectangle');$('invRound').classList.toggle('hidden',p==='rectangle');$('invSector').classList.toggle('hidden',p!=='sector')};
$('addInventoryBtn').onclick=()=>{state.inventory.push({id:uid(),name:$('invName').value.trim()||'Sprinkler',qty:Math.max(1,Number($('invQty').value)||1),pattern:$('invPattern').value,radius:Number($('invRadius').value)||35,angle:Number($('invAngle').value)||180,length:Number($('invLength').value)||50,width:Number($('invWidth').value)||30});save();refreshSelectors();setStatus('Sprinkler added')};
$('clearInventoryBtn').onclick=()=>{state.inventory=[];save();refreshSelectors()};
// Pre-placement analysis: confirm type is suitable before committing stations
function analyzeLayoutFit(item){
  const zone = displayBoundary();
  if(zone.length < 3 || !item) return { ok:true, messages:[] };
  const zoneAreaSqFt = area(zone) * 10.7639;
  const messages = [];
  let ok = true;

  // Rough coverage capacity of one head
  let headArea;
  if(item.pattern === 'rectangle'){
    headArea = (Number(item.length)||50) * (Number(item.width)||30);
  } else {
    const r = Number(item.radius)||35;
    headArea = Math.PI * r * r;
  }
  const estHeads = Math.max(1, Math.ceil(zoneAreaSqFt / (headArea * 0.55)));

  if(noSpray.length){
    if(item.pattern === 'rectangle'){
      messages.push('Oscillating / rectangular heads can be aimed and width-limited to stay off no-spray areas. Set the pattern in the field so spray stops at the red boundary.');
    } else if(item.pattern === 'sector'){
      messages.push('Adjustable-arc heads can be pointed away from no-spray zones. Aim the open arc into the green only.');
    } else {
      messages.push('Full-circle impact heads spray in all directions. Near no-spray areas some mist may reach the red edge — or switch to an adjustable-arc / oscillating head for cleaner edges.');
    }
  }

  if(estHeads > 12 && item.pattern === 'rectangle'){
    messages.push(`This zone is large (~${Math.round(zoneAreaSqFt).toLocaleString()} sq ft). Oscillating heads work well in bands; expect many station positions and rotate them in groups for the well.`);
  }
  if(estHeads > 20 && (item.pattern === 'circle' || !item.pattern)){
    ok = true;
    messages.push(`Large zone: roughly ${estHeads}+ stations of this type for full coverage. That is normal — run only as many as the well allows at a time.`);
  }

  // Suggest alternate type when full-circle is a poor fit next to no-spray
  let suggestion = null;
  if(noSpray.length && item.pattern === 'circle'){
    const alt = state.inventory.find(x => x.id !== item.id && (x.pattern === 'sector' || x.pattern === 'rectangle'));
    if(alt){
      suggestion = alt;
      messages.push(`Recommendation: try “${alt.name}” (${alt.pattern === 'rectangle' ? 'oscillating' : 'adjustable arc'}) for better control next to no-spray areas.`);
    } else {
      messages.push('Recommendation: an oscillating or adjustable-arc sprinkler is usually better than a full-circle impact when buildings/driveways sit on the edge. Check the Store under Inventory.');
    }
  }

  return { ok, messages, estHeads, suggestion };
}

function requestLayout(){
  const item = state.inventory.find(x => x.id === $('layoutSprinklerSelect').value);
  const zone = displayBoundary();
  if(zone.length < 3) return setStatus('Finish a zone boundary first');
  if(!item) return setStatus('Add a sprinkler to inventory first');

  const analysis = analyzeLayoutFit(item);
  if(analysis.messages.length){
    const lines = analysis.messages.map((m,i) => `${i+1}. ${m}`).join('\n\n');
    const extra = analysis.suggestion
      ? `\n\nSwitch to “${analysis.suggestion.name}” before placing? (Cancel = stay on ${item.name} and place anyway)`
      : `\n\nPlace stations with “${item.name}” now?`;
    const proceed = confirm(`Before placing stations:\n\n${lines}${extra}`);
    if(!proceed){
      if(analysis.suggestion){
        $('layoutSprinklerSelect').value = analysis.suggestion.id;
        setStatus(`Switched to ${analysis.suggestion.name} — tap Cover entire zone again when ready`);
      } else {
        setStatus('Placement cancelled — adjust sprinkler type or zone, then try again');
      }
      return;
    }
  }
  generateLayout();
}

$('generateBtn').onclick=requestLayout;
$('clearSprinklersBtn').onclick=()=>{sprinklers=[];renderSprinklers();hideSmartRecommendations();setStatus('Layout cleared')};
$('newProjectBtn').onclick=()=>{const p={id:uid(),name:'New project',zones:[]};state.projects.push(p);state.activeProjectId=p.id;resetZone();save();refreshSelectors()};
$('saveProjectBtn').onclick=()=>{const p=activeProject();if(p)p.name=$('projectName').value.trim()||p.name;save();refreshSelectors();setStatus('Project saved')};
$('renameProjectBtn').onclick=$('saveProjectBtn').onclick;
$('deleteProjectBtn').onclick=()=>{if(state.projects.length===1)return setStatus('At least one project is required');state.projects=state.projects.filter(p=>p.id!==state.activeProjectId);state.activeProjectId=state.projects[0].id;resetZone();save();refreshSelectors();setStatus('Project deleted')};
$('projectSelect').onchange=()=>{state.activeProjectId=$('projectSelect').value;resetZone();save();refreshSelectors()};
$('saveZoneBtn').onclick=()=>{const p=activeProject(),z=zoneObject(),i=p.zones.findIndex(x=>x.id===z.id);if(i>=0)p.zones[i]=z;else p.zones.push(z);state.activeZoneId=z.id;save();refreshSelectors();setStatus(`Saved ${z.name}`)};
$('newZoneBtn').onclick=resetZone;
$('loadZoneBtn').onclick=()=>{const z=activeProject()?.zones.find(x=>x.id===$('zoneSelect').value);if(z)loadZone(z)};
$('zoneSelect').onchange=()=>{const z=activeProject()?.zones.find(x=>x.id===$('zoneSelect').value);if(z)loadZone(z)};
$('deleteZoneBtn').onclick=()=>{const p=activeProject(),id=$('zoneSelect').value;if(!id)return;p.zones=p.zones.filter(z=>z.id!==id);resetZone();save();refreshSelectors();setStatus('Zone deleted')};
$('exportBtn').onclick=()=>{const p=activeProject();const blob=new Blob([JSON.stringify({version:5,project:p,inventory:state.inventory},null,2)],{type:'application/json'}),a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=`${p.name.replace(/[^a-z0-9]+/gi,'_').toLowerCase()}.json`;a.click();URL.revokeObjectURL(url)};
$('importInput').onchange=async e=>{try{const data=JSON.parse(await e.target.files[0].text()),p=data.project||data;if(!Array.isArray(p.zones))throw Error('Invalid project');p.id=p.id||uid();state.projects.push(p);state.activeProjectId=p.id;if(Array.isArray(data.inventory))state.inventory=data.inventory;resetZone();save();refreshSelectors();setStatus('Project imported')}catch(err){setStatus(`Import failed: ${err.message}`)}};
$('zoneName').oninput=updateMetrics;

// ===== Desktop / mouse boundary drawing =====
function setDrawMode(mode){
  drawMode = mode;
  freehandDrawing = false;
  freehandPoints = [];
  // Update button states if present
  const clickBtn = $('drawClickBtn');
  const freeBtn = $('drawFreehandBtn');
  const offBtn = $('drawOffBtn');
  if(clickBtn) clickBtn.classList.toggle('active', mode==='click');
  if(freeBtn) freeBtn.classList.toggle('active', mode==='freehand');
  if(offBtn) offBtn.classList.toggle('active', mode==='none');
  if(mode==='click') setStatus('Click points around the perimeter — lines connect automatically');
  else if(mode==='freehand') setStatus('Click and drag to freehand-draw the perimeter');
  else setStatus('Drawing mode off');
  // Disable map dragging while freehand drawing
  if(mode==='freehand') map.dragging.disable();
  else map.dragging.enable();
}

if($('drawClickBtn')) $('drawClickBtn').onclick = () => setDrawMode(drawMode==='click' ? 'none' : 'click');
if($('drawFreehandBtn')) $('drawFreehandBtn').onclick = () => setDrawMode(drawMode==='freehand' ? 'none' : 'freehand');
if($('drawOffBtn')) $('drawOffBtn').onclick = () => setDrawMode('none');

map.on('click', e => {
  if(drawingAvoid){
    currentAvoid.push(e.latlng); renderAvoid(); updateButtons(); return;
  }
  if(addVertexMode){
    boundary.push(e.latlng); smooth=[]; renderBoundary(); return;
  }
  if(removeVertexMode && boundary.length){
    let best=0, bd=Infinity;
    boundary.forEach((p,i)=>{ const d=dist(p,e.latlng); if(d<bd){bd=d;best=i;} });
    if(bd<15){ boundary.splice(best,1); smooth=[]; renderBoundary(); }
    return;
  }
  // Sequential click-to-place points
  if(drawMode==='click'){
    boundary.push(e.latlng); smooth=[]; renderBoundary();
    setStatus(`Point ${boundary.length} placed — keep clicking or Finish boundary`);
    return;
  }
  if(walking && !paused){
    boundary.push(e.latlng); smooth=[]; renderBoundary();
  }
});

// Freehand: mousedown → mousemove → mouseup
map.on('mousedown', e => {
  if(drawMode !== 'freehand' || drawingAvoid) return;
  freehandDrawing = true;
  freehandPoints = [e.latlng];
  map.dragging.disable();
});
map.on('mousemove', e => {
  if(!freehandDrawing || drawMode !== 'freehand') return;
  const last = freehandPoints[freehandPoints.length-1];
  if(last && dist(last, e.latlng) < 1.2) return; // throttle points
  freehandPoints.push(e.latlng);
  // Live preview line
  if(window._freehandLine) map.removeLayer(window._freehandLine);
  window._freehandLine = L.polyline(freehandPoints, {color:'#176b3a', weight:3, dashArray:'4,6'}).addTo(map);
});
map.on('mouseup', e => {
  if(!freehandDrawing || drawMode !== 'freehand') return;
  freehandDrawing = false;
  if(window._freehandLine){ map.removeLayer(window._freehandLine); window._freehandLine=null; }
  if(freehandPoints.length >= 2){
    // Append freehand stroke to boundary
    freehandPoints.forEach(p => boundary.push(p));
    smooth = [];
    renderBoundary();
    setStatus(`Freehand added — ${boundary.length} total points. Continue or Finish boundary.`);
  }
  freehandPoints = [];
  map.dragging.enable();
});
// Also handle touch-end equivalent for mouse leaving map
map.on('mouseout', () => {
  if(freehandDrawing){
    freehandDrawing = false;
    if(window._freehandLine){ map.removeLayer(window._freehandLine); window._freehandLine=null; }
    map.dragging.enable();
  }
});

map.on('dragstart',()=>{if(followUser){followUser=false;userMovedMap=true;$('resumeFollowBtn').classList.remove('hidden')}});

// ===== Deploy: tap marker to mark satisfied =====
function toggleSprinklerDone(idx){
  if(deployed.has(idx)) deployed.delete(idx);
  else deployed.add(idx);
  renderSprinklers();
  updateDeployProgressUI();
  if(deployed.size >= sprinklers.length && sprinklers.length > 0){
    setStatus('All positions satisfied — cycle complete. Ready to reset.');
    if($('cycleCompleteBanner')) $('cycleCompleteBanner').classList.remove('hidden');
  } else {
    if($('cycleCompleteBanner')) $('cycleCompleteBanner').classList.add('hidden');
  }
}
function updateDeployProgressUI(){
  const total = sprinklers.length;
  const done = deployed.size;
  if($('deployProgress')) $('deployProgress').textContent = total ? `${done} of ${total} satisfied` : 'No sprinklers';
  if($('resetCycleBtn')) $('resetCycleBtn').disabled = done === 0;
}
function resetWateringCycle(){
  deployed = new Set();
  renderSprinklers();
  updateDeployProgressUI();
  if($('cycleCompleteBanner')) $('cycleCompleteBanner').classList.add('hidden');
  setStatus('Watering cycle reset — ready to go again');
}
if($('resetCycleBtn')) $('resetCycleBtn').onclick = resetWateringCycle;
if($('resetCycleBtn2')) $('resetCycleBtn2').onclick = resetWateringCycle;

try{state=JSON.parse(localStorage.getItem(STORE))||defaultState()}catch{state=defaultState()}if(!state.projects?.length)state=defaultState();
state.version=13;refreshSelectors();refreshDeployChoices();renderAll();save();startGPS(true);
goToStep('project'); // start on project step
if($('appVersion')) $('appVersion').textContent = 'v' + APP_VERSION;

// Auth button
if($('authBtn')){
  $('authBtn').onclick = ()=>{
    if(currentUser) signOut();
    else signIn();
  };
}

// Start cloud if keys are present
initCloud();

if('serviceWorker'in navigator)navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
