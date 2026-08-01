const $=id=>document.getElementById(id), setStatus=t=>$('status').textContent=t;
const map=L.map('map').setView([44.05,-123.1],17);
const street=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:20,attribution:'&copy; OpenStreetMap'});
const imagery=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:20,attribution:'Tiles &copy; Esri'}).addTo(map);
L.control.layers({Satellite:imagery,Streets:street}).addTo(map);

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
const uid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);
const ftToM=ft=>Number(ft)*.3048, mToFt=m=>m/.3048;
function dist(a,b){const R=6371000,p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180,dp=(b.lat-a.lat)*Math.PI/180,dl=(b.lng-a.lng)*Math.PI/180,h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function localXY(p,o){const R=6371000,c=Math.cos(o.lat*Math.PI/180);return{x:(p.lng-o.lng)*Math.PI/180*R*c,y:(p.lat-o.lat)*Math.PI/180*R}}
function ll(p,o){const R=6371000,c=Math.cos(o.lat*Math.PI/180);return{lat:o.lat+p.y/R*180/Math.PI,lng:o.lng+p.x/(R*c)*180/Math.PI}}
function pip(p,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if(((a.y>p.y)!=(b.y>p.y))&&p.x<(b.x-a.x)*(p.y-a.y)/((b.y-a.y)||1e-9)+a.x)inside=!inside}return inside}
function area(points){if(points.length<3)return 0;const o=points[0],q=points.map(p=>localXY(p,o));let a=0;for(let i=0,j=q.length-1;i<q.length;j=i++)a+=q[j].x*q[i].y-q[i].x*q[j].y;return Math.abs(a/2)}
function chaikin(points,it=2){if(points.length<3)return points.slice();let out=points.slice();for(let k=0;k<it;k++){const n=[];for(let i=0;i<out.length;i++){const a=out[i],b=out[(i+1)%out.length];n.push({lat:.75*a.lat+.25*b.lat,lng:.75*a.lng+.25*b.lng},{lat:.25*a.lat+.75*b.lat,lng:.25*a.lng+.75*b.lng})}out=n}return out}
function centroid(points){const o=points[0],q=points.map(p=>localXY(p,o));return ll({x:q.reduce((s,p)=>s+p.x,0)/q.length,y:q.reduce((s,p)=>s+p.y,0)/q.length},o)}

let state={version:8,activeProjectId:null,activeZoneId:null,projects:[],inventory:[]};
let boundary=[],smooth=[],noSpray=[],sprinklers=[],currentAvoid=[];
let walking=false,paused=false,drawingAvoid=false,editMode=false,addVertexMode=false,removeVertexMode=false;
let watchId=null,currentPosition=null,gpsSamples=[];
let poorFixStart=null; // timestamp when accuracy first went bad while walking
let userMarker,accuracyCircle,boundaryLine,boundaryPoly,currentAvoidLine;
let avoidLayers=[],vertexMarkers=[],sprinklerLayers=[];

function defaultState(){const p={id:uid(),name:'Home',zones:[]};return{version:8,activeProjectId:p.id,activeZoneId:null,projects:[p],inventory:[{id:uid(),name:'Generic impact',qty:4,pattern:'circle',radius:35,angle:360,length:0,width:0}]}}

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
function loadZone(z){state.activeZoneId=z.id;boundary=(z.boundary||[]).map(p=>({...p}));smooth=(z.smooth||[]).map(p=>({...p}));noSpray=(z.noSpray||[]).map(a=>({name:a.name,points:a.points.map(p=>({...p}))}));sprinklers=(z.sprinklers||[]).map(s=>({...s}));$('zoneName').value=z.name;walking=paused=drawingAvoid=editMode=addVertexMode=removeVertexMode=false;poorFixStart=null;renderAll();if(boundary.length)map.fitBounds(L.latLngBounds(displayBoundary()),{padding:[25,25]});refreshSelectors();setStatus(`Loaded ${z.name}`)}
function resetZone(){state.activeZoneId=null;boundary=[];smooth=[];noSpray=[];sprinklers=[];currentAvoid=[];$('zoneName').value='New zone';walking=paused=false;poorFixStart=null;renderAll();refreshSelectors();setStatus('New blank zone')}

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
function coverageLayer(s,i){const pos=s.position,label=`<div>${i+1}</div>`;if(s.pattern==='rectangle'){const o=pos,halfW=s.width/2,halfL=s.length/2,pts=[ll({x:-halfW,y:-halfL},o),ll({x:halfW,y:-halfL},o),ll({x:halfW,y:halfL},o),ll({x:-halfW,y:halfL},o)];const poly=L.polygon(pts,{color:'#1976c8',fillOpacity:.14,weight:2}).addTo(map);return [poly,L.marker(pos,{icon:L.divIcon({className:'sprinkler-label',html:label,iconSize:[28,28],iconAnchor:[14,14]})}).addTo(map)]}
const circle=L.circle(pos,{radius:s.radius,color:'#1976c8',fillOpacity:.12,weight:2}).addTo(map);return[circle,L.marker(pos,{icon:L.divIcon({className:'sprinkler-label',html:label,iconSize:[28,28],iconAnchor:[14,14]})}).addTo(map)]}
function renderSprinklers(){sprinklerLayers.flat().forEach(removeLayer);sprinklerLayers=[];sprinklers.forEach((s,i)=>sprinklerLayers.push(coverageLayer(s,i)));updateCoverage()}
function renderAll(){renderBoundary();renderAvoid();renderSprinklers();updateButtons()}
function updateButtons(){$('pauseWalkBtn').disabled=!walking;$('finishWalkBtn').disabled=!walking||boundary.length<3;$('pauseWalkBtn').textContent=paused?'Resume':'Pause';$('finishAvoidBtn').disabled=!drawingAvoid||currentAvoid.length<3;$('editBtn').textContent=editMode?'Done editing':'Edit points'}
function updateMetrics(){$('pointCount').textContent=boundary.length;const a=area(displayBoundary());$('areaValue').textContent=a?`${Math.round(a*10.7639).toLocaleString()} sq ft`:'—';$('activeZoneLabel').textContent=$('zoneName').value||'Unnamed'}

function refreshSelectors(){const ps=$('projectSelect');ps.innerHTML=state.projects.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');ps.value=state.activeProjectId||'';const p=activeProject();$('projectName').value=p?.name||'';const zs=$('zoneSelect');zs.innerHTML=p?.zones.length?p.zones.map(z=>`<option value="${z.id}">${z.name}</option>`).join(''):'<option value="">No saved zones</option>';if(state.activeZoneId)zs.value=state.activeZoneId;renderInventory();refreshLayoutChoices()}
function renderInventory(){const box=$('inventoryList');box.innerHTML=state.inventory.length?'':'<p class="help">No sprinklers saved.</p>';state.inventory.forEach(item=>{const d=document.createElement('div');d.className='list-item';const desc=item.pattern==='rectangle'?`${item.length} × ${item.width} ft rectangle`:`${item.radius} ft radius${item.pattern==='sector'?`, ${item.angle}° max`:''}`;d.innerHTML=`<div><strong>${item.name} ×${item.qty}</strong><small>${desc}</small></div><button class="danger" data-id="${item.id}">Delete</button>`;d.querySelector('button').onclick=()=>{state.inventory=state.inventory.filter(x=>x.id!==item.id);save();refreshSelectors()};box.appendChild(d)})}
function refreshLayoutChoices(){const s=$('layoutSprinklerSelect');s.innerHTML=state.inventory.length?state.inventory.map(x=>`<option value="${x.id}">${x.name} ×${x.qty}</option>`).join(''):'<option value="">Add a sprinkler first</option>'}

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
function centerMapOnUser(){if(!currentPosition)return;map.setView(currentPosition,19);centerOnNextFix=false;followUser=true;userMovedMap=false;$('resumeFollowBtn').classList.add('hidden')}
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
function updateCoverage(){const r=sampleCoverage();$('sprinklerCount').textContent=sprinklers.length;if(!r){['coverageValue','uncoveredValue','oversprayValue','overlapValue'].forEach(id=>$(id).textContent='—');return}$('coverageValue').textContent=`${r.coverage.toFixed(1)}%`;$('uncoveredValue').textContent=`${Math.round(r.uncoveredSqFt)} sq ft`;$('oversprayValue').textContent=`${r.overspray.toFixed(1)}%`;$('overlapValue').textContent=`${r.overlap.toFixed(0)}%`;$('recommendValue').textContent=r.coverage>=99?'Good':r.coverage>=95?'Minor adjustment':'Add or reposition'}
function candidateAllowed(q,o,poly,avoids){const p=localXY(q,o);return pip(p,poly)&&!avoids.some(a=>pip(p,a))}
function generateLayout(){const zone=displayBoundary(),item=state.inventory.find(x=>x.id===$('layoutSprinklerSelect').value);if(zone.length<3)return setStatus('Finish a zone boundary first');if(!item)return setStatus('Add a sprinkler to inventory first');sprinklers=[];const o=zone[0],poly=zone.map(p=>localXY(p,o)),avoids=noSpray.map(a=>a.points.map(p=>localXY(p,o))),xs=poly.map(p=>p.x),ys=poly.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);const mode=$('priority').value;let sx,sy;if(item.pattern==='rectangle'){const f=mode==='water'?.95:mode==='coverage'?.65:.8;sx=ftToM(item.width)*f;sy=ftToM(item.length)*f}else{const r=ftToM(item.radius),f=mode==='water'?1.75:mode==='coverage'?1.15:1.42;sx=r*f;sy=sx*.866}const max=$('inventoryOnly').checked?item.qty:999;let row=0;for(let y=minY;y<=maxY&&sprinklers.length<max;y+=sy){const off=(row++%2)*sx/2;for(let x=minX+off;x<=maxX&&sprinklers.length<max;x+=sx){const q=ll({x,y},o);if(!candidateAllowed(q,o,poly,avoids))continue;sprinklers.push({inventoryId:item.id,name:item.name,pattern:item.pattern,position:q,radius:ftToM(item.radius||0),angle:item.angle||360,length:ftToM(item.length||0),width:ftToM(item.width||0)})}}if(!sprinklers.length){const c=centroid(zone);sprinklers.push({inventoryId:item.id,name:item.name,pattern:item.pattern,position:c,radius:ftToM(item.radius||0),angle:item.angle||360,length:ftToM(item.length||0),width:ftToM(item.width||0)})}renderSprinklers();const r=sampleCoverage();if(r&&r.coverage<98&&$('inventoryOnly').checked&&sprinklers.length>=item.qty)$('recommendValue').textContent='More units may help';setStatus(`Placed ${sprinklers.length} ${item.name}${sprinklers.length===1?'':'s'}`)}


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

// Tabs
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tabbody').forEach(x=>x.classList.remove('active'));t.classList.add('active');$(`${t.dataset.tab}Tab`).classList.add('active');setTimeout(()=>map.invalidateSize(),80)});
$('plannerModeBtn').onclick=()=>setMode('planner');$('deployModeBtn').onclick=()=>setMode('deploy');$('startDeployBtn').onclick=()=>beginDeployment(false);$('resumeDeployBtn').onclick=()=>beginDeployment(true);$('placedBtn').onclick=()=>nextDeploy(true);$('skipBtn').onclick=()=>nextDeploy(false);$('previousBtn').onclick=()=>{deployIndex=Math.max(0,deployIndex-1);lastSpokenDistance=null;showDeployTarget()};$('endDeployBtn').onclick=()=>{$('deployActive').classList.add('hidden');deployZone=null;setStatus('Setup ended')};$('deployZoneSelect').onchange=()=>{const x=selectedDeployZone();$('deployTitle').textContent=x?.zone?.name||'Choose a saved layout'};
$('floatingLocateBtn').onclick=()=>startGPS(true);
$('resumeFollowBtn').onclick=()=>startGPS(true);
$('startWalkBtn').onclick=()=>{startGPS(true);walking=true;paused=false;poorFixStart=null;boundary=[];smooth=[];sprinklers=[];renderAll();setStatus('Recording perimeter — walk slowly, keep phone skyward')};
$('pauseWalkBtn').onclick=()=>{paused=!paused;poorFixStart=null;updateButtons();setStatus(paused?'Recording paused':'Recording resumed')};
$('addPointBtn').onclick=addAveragedPoint;
$('finishWalkBtn').onclick=()=>{walking=false;paused=false;poorFixStart=null;smooth=chaikin(boundary,2);renderAll();if(boundary.length)map.fitBounds(L.latLngBounds(displayBoundary()),{padding:[25,25]});setStatus('Boundary finished')};
$('smoothBtn').onclick=()=>{if(boundary.length<3)return setStatus('Add at least 3 points');smooth=chaikin(boundary,2);renderBoundary();setStatus('Boundary display smoothed')};
$('editBtn').onclick=()=>{editMode=!editMode;addVertexMode=removeVertexMode=false;renderBoundary();updateButtons();setStatus(editMode?'Drag numbered points to adjust':'Editing finished')};
$('addVertexBtn').onclick=()=>{addVertexMode=!addVertexMode;removeVertexMode=editMode=false;renderBoundary();setStatus(addVertexMode?'Tap the map to add boundary points':'Add-point mode off')};
$('removeVertexBtn').onclick=()=>{removeVertexMode=!removeVertexMode;addVertexMode=editMode=false;renderBoundary();setStatus(removeVertexMode?'Tap near a numbered point to remove it':'Remove-point mode off')};
$('clearBoundaryBtn').onclick=resetZone;
$('drawAvoidBtn').onclick=()=>{drawingAvoid=true;currentAvoid=[];walking=false;renderAvoid();updateButtons();setStatus('Tap around the no-spray area')};
$('finishAvoidBtn').onclick=()=>{if(currentAvoid.length<3)return;noSpray.push({name:$('avoidName').value.trim()||`No-spray ${noSpray.length+1}`,points:[...currentAvoid]});currentAvoid=[];drawingAvoid=false;renderAvoid();updateCoverage();updateButtons();setStatus('No-spray area saved')};
$('deleteAvoidBtn').onclick=()=>{noSpray.pop();renderAvoid();updateCoverage()};$('clearAvoidBtn').onclick=()=>{noSpray=[];currentAvoid=[];drawingAvoid=false;renderAvoid();updateCoverage();updateButtons()};
$('invPattern').onchange=()=>{const p=$('invPattern').value;$('invRect').classList.toggle('hidden',p!=='rectangle');$('invRound').classList.toggle('hidden',p==='rectangle');$('invSector').classList.toggle('hidden',p!=='sector')};
$('addInventoryBtn').onclick=()=>{state.inventory.push({id:uid(),name:$('invName').value.trim()||'Sprinkler',qty:Math.max(1,Number($('invQty').value)||1),pattern:$('invPattern').value,radius:Number($('invRadius').value)||35,angle:Number($('invAngle').value)||180,length:Number($('invLength').value)||50,width:Number($('invWidth').value)||30});save();refreshSelectors();setStatus('Sprinkler added')};
$('clearInventoryBtn').onclick=()=>{state.inventory=[];save();refreshSelectors()};
$('generateBtn').onclick=generateLayout;$('clearSprinklersBtn').onclick=()=>{sprinklers=[];renderSprinklers();setStatus('Layout cleared')};
$('newProjectBtn').onclick=()=>{const p={id:uid(),name:'New project',zones:[]};state.projects.push(p);state.activeProjectId=p.id;resetZone();save();refreshSelectors()};
$('saveProjectBtn').onclick=()=>{const p=activeProject();if(p)p.name=$('projectName').value.trim()||p.name;save();refreshSelectors();setStatus('Project saved')};
$('renameProjectBtn').onclick=$('saveProjectBtn').onclick;
$('deleteProjectBtn').onclick=()=>{if(state.projects.length===1)return setStatus('At least one project is required');state.projects=state.projects.filter(p=>p.id!==state.activeProjectId);state.activeProjectId=state.projects[0].id;resetZone();save();refreshSelectors();setStatus('Project deleted')};
$('projectSelect').onchange=()=>{state.activeProjectId=$('projectSelect').value;resetZone();save();refreshSelectors()};
$('saveZoneBtn').onclick=()=>{const p=activeProject(),z=zoneObject(),i=p.zones.findIndex(x=>x.id===z.id);if(i>=0)p.zones[i]=z;else p.zones.push(z);state.activeZoneId=z.id;save();refreshSelectors();setStatus(`Saved ${z.name}`)};
$('newZoneBtn').onclick=resetZone;$('loadZoneBtn').onclick=()=>{const z=activeProject()?.zones.find(x=>x.id===$('zoneSelect').value);if(z)loadZone(z)};$('zoneSelect').onchange=()=>{const z=activeProject()?.zones.find(x=>x.id===$('zoneSelect').value);if(z)loadZone(z)};
$('deleteZoneBtn').onclick=()=>{const p=activeProject(),id=$('zoneSelect').value;if(!id)return;p.zones=p.zones.filter(z=>z.id!==id);resetZone();save();refreshSelectors();setStatus('Zone deleted')};
$('exportBtn').onclick=()=>{const p=activeProject();const blob=new Blob([JSON.stringify({version:5,project:p,inventory:state.inventory},null,2)],{type:'application/json'}),a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=`${p.name.replace(/[^a-z0-9]+/gi,'_').toLowerCase()}.json`;a.click();URL.revokeObjectURL(url)};
$('importInput').onchange=async e=>{try{const data=JSON.parse(await e.target.files[0].text()),p=data.project||data;if(!Array.isArray(p.zones))throw Error('Invalid project');p.id=p.id||uid();state.projects.push(p);state.activeProjectId=p.id;if(Array.isArray(data.inventory))state.inventory=data.inventory;resetZone();save();refreshSelectors();setStatus('Project imported')}catch(err){setStatus(`Import failed: ${err.message}`)}};
$('zoneName').oninput=updateMetrics;
map.on('click',e=>{if(drawingAvoid){currentAvoid.push(e.latlng);renderAvoid();updateButtons();return}if(addVertexMode){boundary.push(e.latlng);smooth=[];renderBoundary();return}if(removeVertexMode&&boundary.length){let best=0,bd=Infinity;boundary.forEach((p,i)=>{const d=dist(p,e.latlng);if(d<bd){bd=d;best=i}});if(bd<15){boundary.splice(best,1);smooth=[];renderBoundary()}return}if(walking&&!paused){boundary.push(e.latlng);smooth=[];renderBoundary()}});

map.on('dragstart',()=>{if(followUser){followUser=false;userMovedMap=true;$('resumeFollowBtn').classList.remove('hidden')}});
try{state=JSON.parse(localStorage.getItem(STORE))||defaultState()}catch{state=defaultState()}if(!state.projects?.length)state=defaultState();
state.version=8;refreshSelectors();refreshDeployChoices();renderAll();save();startGPS(true);

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
