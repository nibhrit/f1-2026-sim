// ============================================================
// F1 2026 — Track layouts (stylized approximations) + Drivers
// Points are [x, z] in meters, closed loops, smoothed at build.
// ============================================================

const TEAMS = {
  redbull:     { name:'Red Bull Racing', color:0x16255e, accent:0xe10600 },
  ferrari:     { name:'Ferrari',         color:0xe8002d, accent:0xfff200 },
  mercedes:    { name:'Mercedes',        color:0x27f4d2, accent:0x0a0a0a },
  mclaren:     { name:'McLaren',         color:0xff8000, accent:0x111111 },
  aston:       { name:'Aston Martin',    color:0x229971, accent:0xcedc00 },
  alpine:      { name:'Alpine',          color:0x0093cc, accent:0xff87bc },
  williams:    { name:'Williams',        color:0x1868db, accent:0x9fd8ff },
  audi:        { name:'Audi',            color:0x86868c, accent:0xd50000 },
  racingbulls: { name:'Racing Bulls',    color:0x6692ff, accent:0xffffff },
  haas:        { name:'Haas',            color:0xe6e6e6, accent:0xda291c },
  cadillac:    { name:'Cadillac',        color:0xcba135, accent:0x101010 },
};

// tyre compounds: grip multiplier + wear rate per km driven
// wetOptimal: track wetness (0..1) the compound performs best at (0 = slick, dry)
const COMPOUNDS = {
  soft:   { label:'S', color:0xd02020, grip:1.02,  wearPerKm:0.0030, wetOptimal:0 },
  medium: { label:'M', color:0xf5c518, grip:1.0,   wearPerKm:0.0018, wetOptimal:0 },
  hard:   { label:'H', color:0xe8e8e8, grip:0.985, wearPerKm:0.0011, wetOptimal:0 },
};

// wet-weather tyres: intermediate + full wet. Merged into COMPOUNDS below so
// CarPhysics can setTyre('inter')/'wet' and read grip/wear/wetOptimal uniformly.
const WET_TYRES = {
  inter: { label:'I', color:0x3fbf4f, grip:1.0, wearPerKm:0.0016, wetOptimal:0.5 },
  wet:   { label:'W', color:0x2f7fd0, grip:1.0, wearPerKm:0.0014, wetOptimal:0.9 },
};
COMPOUNDS.inter = WET_TYRES.inter;
COMPOUNDS.wet   = WET_TYRES.wet;

// skill: 0..1 → affects AI pace/consistency
const DRIVERS = [
  { id:'VER', name:'Max Verstappen',    team:'redbull',     skill:0.99, player:true },
  { id:'HAD', name:'Isack Hadjar',      team:'redbull',     skill:0.90 },
  { id:'LEC', name:'Charles Leclerc',   team:'ferrari',     skill:0.95 },
  { id:'HAM', name:'Lewis Hamilton',    team:'ferrari',     skill:0.94 },
  { id:'RUS', name:'George Russell',    team:'mercedes',    skill:0.94 },
  { id:'ANT', name:'Andrea K. Antonelli',team:'mercedes',   skill:0.91 },
  { id:'NOR', name:'Lando Norris',      team:'mclaren',     skill:0.96 },
  { id:'PIA', name:'Oscar Piastri',     team:'mclaren',     skill:0.96 },
  { id:'ALO', name:'Fernando Alonso',   team:'aston',       skill:0.93 },
  { id:'STR', name:'Lance Stroll',      team:'aston',       skill:0.85 },
  { id:'GAS', name:'Pierre Gasly',      team:'alpine',      skill:0.89 },
  { id:'COL', name:'Franco Colapinto',  team:'alpine',      skill:0.86 },
  { id:'ALB', name:'Alex Albon',        team:'williams',    skill:0.90 },
  { id:'SAI', name:'Carlos Sainz',      team:'williams',    skill:0.92 },
  { id:'HUL', name:'Nico Hulkenberg',   team:'audi',        skill:0.88 },
  { id:'BOR', name:'Gabriel Bortoleto', team:'audi',        skill:0.87 },
  { id:'LAW', name:'Liam Lawson',       team:'racingbulls', skill:0.88 },
  { id:'LIN', name:'Arvid Lindblad',    team:'racingbulls', skill:0.85 },
  { id:'OCO', name:'Esteban Ocon',      team:'haas',        skill:0.88 },
  { id:'BEA', name:'Oliver Bearman',    team:'haas',        skill:0.87 },
  { id:'PER', name:'Sergio Perez',      team:'cadillac',    skill:0.89 },
  { id:'BOT', name:'Valtteri Bottas',   team:'cadillac',    skill:0.87 },
];

// helper for readable point lists
function P(arr){ return arr.map(p => ({x:p[0], z:p[1]})); }

const TRACKS = [
{ id:'australia', round:1, name:'Albert Park', gp:'Australian GP', country:'Australia', laps:5, width:13,
  points:P([[0,0],[180,-6],[330,-20],[420,-70],[430,-150],[370,-200],[290,-195],[240,-240],[250,-330],[320,-390],[420,-400],[520,-360],[560,-270],[545,-170],[580,-90],[560,0],[480,60],[380,110],[420,200],[380,290],[280,330],[160,340],[40,320],[-60,330],[-160,300],[-220,220],[-230,120],[-280,60],[-350,20],[-370,-60],[-310,-110],[-210,-110],[-120,-70],[-60,-20]]) },

{ id:'china', round:2, name:'Shanghai Intl.', gp:'Chinese GP', country:'China', laps:5, width:14,
  points:P([[0,0],[180,-5],[330,-15],[430,-60],[470,-140],[440,-220],[360,-260],[260,-250],[180,-290],[80,-310],[-30,-300],[-110,-250],[-130,-170],[-80,-115],[0,-100],[80,-120],[150,-170],[230,-190],[310,-170],[350,-110],[330,-55],[240,-45],[140,-50],[40,-55],[-70,-50],[-160,-15],[-150,45],[-70,40],[-15,15]]) },

{ id:'japan', round:3, name:'Suzuka', gp:'Japanese GP', country:'Japan', laps:5, width:12,
  points:P([[0,0],[160,-10],[300,-40],[380,-110],[360,-200],[280,-240],[200,-210],[150,-150],[80,-120],[10,-150],[-20,-220],[30,-290],[130,-320],[250,-330],[370,-310],[470,-330],[560,-300],[600,-220],[570,-140],[610,-60],[650,30],[610,120],[520,160],[400,150],[280,180],[160,220],[30,240],[-90,220],[-170,150],[-180,60],[-120,10]]) },

{ id:'bahrain', round:4, name:'Bahrain Intl.', gp:'Bahrain GP', country:'Bahrain', laps:5, width:14,
  points:P([[0,0],[190,-5],[340,-15],[420,-70],[420,-150],[350,-190],[260,-170],[200,-210],[210,-300],[290,-360],[400,-370],[490,-320],[510,-230],[470,-150],[520,-80],[590,-40],[620,50],[570,130],[470,160],[360,140],[260,170],[190,240],[90,280],[-30,270],[-130,230],[-190,150],[-190,50],[-130,5]]) },

{ id:'saudi', round:5, name:'Jeddah Corniche', gp:'Saudi Arabian GP', country:'Saudi Arabia', laps:5, width:12,
  points:P([[0,0],[200,-8],[400,-16],[560,-30],[660,-80],[680,-160],[620,-210],[520,-200],[430,-230],[350,-210],[260,-240],[180,-220],[90,-250],[10,-230],[-80,-260],[-160,-240],[-240,-270],[-330,-250],[-400,-200],[-430,-120],[-400,-50],[-320,-20],[-240,-45],[-160,-20],[-80,-40],[-40,-15]]) },

{ id:'miami', round:6, name:'Miami Intl. Autodrome', gp:'Miami GP', country:'USA', laps:5, width:13,
  points:P([[0,0],[190,-6],[350,-20],[450,-70],[480,-160],[430,-240],[330,-280],[230,-260],[140,-300],[30,-320],[-80,-300],[-140,-240],[-130,-160],[-190,-110],[-280,-120],[-340,-180],[-420,-190],[-470,-130],[-460,-50],[-400,10],[-330,60],[-240,90],[-150,75],[-80,40],[-25,12]]) },

{ id:'canada', round:7, name:'Circuit Gilles Villeneuve', gp:'Canadian GP', country:'Canada', laps:5, width:13,
  points:P([[0,0],[210,-10],[380,-30],[470,-80],[490,-160],[430,-210],[340,-200],[260,-230],[180,-215],[100,-245],[20,-230],[-60,-260],[-150,-245],[-240,-270],[-340,-255],[-430,-280],[-520,-250],[-570,-180],[-560,-100],[-490,-60],[-400,-70],[-310,-45],[-220,-65],[-130,-40],[-60,-55],[-25,-30]]) },

{ id:'monaco', round:8, name:'Circuit de Monaco', gp:'Monaco GP', country:'Monaco', laps:5, width:10,
  points:P([[0,0],[120,-5],[220,-25],[290,-80],[300,-160],[250,-215],[170,-230],[110,-190],[100,-120],[50,-80],[-20,-90],[-70,-140],[-140,-160],[-210,-130],[-230,-60],[-200,0],[-140,30],[-150,90],[-210,120],[-270,170],[-260,240],[-190,270],[-100,260],[-20,220],[50,170],[130,140],[210,150],[260,200],[330,220],[390,180],[390,100],[330,50],[230,40],[80,35],[-70,25],[-130,-5],[-55,-14]]) },

{ id:'spain', round:9, name:'Barcelona-Catalunya', gp:'Spanish GP', country:'Spain', laps:5, width:13,
  points:P([[0,0],[200,-6],[380,-20],[490,-70],[520,-160],[470,-240],[370,-270],[270,-250],[190,-280],[90,-290],[0,-260],[-70,-200],[-100,-120],[-170,-80],[-260,-90],[-330,-40],[-340,50],[-280,110],[-190,120],[-110,160],[-30,210],[70,230],[180,220],[270,250],[370,240],[430,180],[420,100],[350,60],[240,45],[120,40],[-60,45],[-140,10],[-70,-8]]) },

{ id:'austria', round:10, name:'Red Bull Ring', gp:'Austrian GP', country:'Austria', laps:5, width:14,
  points:P([[0,0],[190,-10],[360,-35],[470,-100],[490,-190],[430,-250],[340,-250],[280,-300],[290,-380],[370,-420],[470,-410],[540,-340],[540,-240],[580,-160],[570,-70],[500,-10],[400,10],[290,60],[180,120],[70,160],[-50,170],[-160,140],[-230,70],[-230,-20],[-160,-40],[-80,-20]]) },

{ id:'britain', round:11, name:'Silverstone', gp:'British GP', country:'Great Britain', laps:5, width:14,
  points:P([[0,0],[190,-8],[350,-30],[460,-90],[490,-180],[440,-250],[340,-280],[240,-260],[160,-300],[150,-380],[220,-430],[330,-440],[440,-410],[530,-350],[560,-260],[610,-180],[620,-90],[560,-20],[470,10],[390,70],[300,110],[200,110],[110,150],[50,220],[-40,260],[-140,250],[-230,200],[-280,120],[-270,30],[-200,-20],[-100,-25]]) },

{ id:'belgium', round:12, name:'Spa-Francorchamps', gp:'Belgian GP', country:'Belgium', laps:4, width:13,
  points:P([[0,0],[150,-5],[230,-45],[260,-120],[330,-180],[440,-220],[560,-250],[670,-290],[750,-350],[790,-430],[750,-500],[650,-520],[550,-490],[470,-430],[380,-390],[280,-360],[190,-310],[110,-250],[40,-190],[-40,-140],[-130,-110],[-230,-120],[-310,-170],[-400,-190],[-480,-150],[-500,-70],[-450,-10],[-360,20],[-260,20],[-160,35],[-70,20]]) },

{ id:'hungary', round:13, name:'Hungaroring', gp:'Hungarian GP', country:'Hungary', laps:5, width:12,
  points:P([[0,0],[170,-6],[310,-25],[390,-80],[400,-160],[340,-215],[250,-225],[170,-190],[110,-230],[110,-310],[180,-360],[280,-370],[370,-330],[420,-250],[480,-190],[520,-110],[500,-25],[430,30],[330,45],[230,90],[130,140],[20,160],[-90,145],[-180,95],[-220,15],[-190,-50],[-110,-35],[-50,-10]]) },

{ id:'netherlands', round:14, name:'Zandvoort', gp:'Dutch GP', country:'Netherlands', laps:5, width:12,
  points:P([[0,0],[170,-8],[300,-40],[370,-110],[360,-195],[290,-240],[200,-230],[130,-270],[120,-350],[190,-400],[290,-405],[380,-360],[420,-280],[480,-220],[520,-140],[500,-55],[430,-5],[340,10],[250,55],[170,115],[80,150],[-30,155],[-130,125],[-195,60],[-200,-25],[-140,-45],[-60,-20]]) },

{ id:'italy', round:15, name:'Monza', gp:'Italian GP', country:'Italy', laps:4, width:13,
  points:P([[0,0],[220,-6],[440,-14],[600,-25],[700,-80],[710,-170],[650,-230],[550,-240],[450,-280],[380,-350],[280,-390],[170,-380],[90,-320],[60,-230],[90,-140],[60,-60],[-40,-30],[-150,-45],[-260,-40],[-360,-60],[-440,-30],[-470,50],[-420,120],[-320,140],[-200,130],[-90,90],[-30,40]]) },

{ id:'madrid', round:16, name:'Madring', gp:'Madrid GP', country:'Spain', laps:5, width:13,
  points:P([[0,0],[180,-6],[330,-20],[440,-60],[500,-130],[490,-220],[420,-270],[320,-270],[230,-310],[130,-320],[40,-280],[-20,-210],[-90,-170],[-180,-180],[-250,-130],[-260,-40],[-310,20],[-390,50],[-420,130],[-370,200],[-270,220],[-160,200],[-60,220],[50,240],[160,220],[240,160],[260,80],[190,45],[90,30]]) },

{ id:'azerbaijan', round:17, name:'Baku City Circuit', gp:'Azerbaijan GP', country:'Azerbaijan', laps:5, width:12,
  points:P([[0,0],[230,-8],[460,-16],[640,-26],[760,-70],[790,-150],[730,-210],[630,-215],[540,-190],[450,-210],[360,-190],[300,-140],[230,-120],[160,-150],[90,-130],[40,-80],[-30,-60],[-110,-80],[-170,-130],[-250,-150],[-340,-130],[-390,-70],[-380,10],[-310,50],[-220,45],[-130,25],[-60,10]]) },

{ id:'singapore', round:18, name:'Marina Bay', gp:'Singapore GP', country:'Singapore', laps:5, width:12,
  points:P([[0,0],[180,-6],[330,-20],[430,-70],[450,-150],[390,-205],[300,-215],[220,-180],[140,-200],[60,-175],[-20,-200],[-100,-175],[-180,-200],[-260,-170],[-310,-110],[-300,-30],[-350,30],[-430,60],[-450,140],[-390,200],[-290,210],[-200,180],[-110,200],[-20,175],[70,200],[160,175],[250,200],[340,180],[400,120],[380,55],[300,40],[150,45],[-60,50],[-130,12],[-60,-10]]) },

{ id:'usa', round:19, name:'Circuit of the Americas', gp:'United States GP', country:'USA', laps:5, width:14,
  points:P([[0,0],[60,-90],[140,-140],[240,-130],[310,-70],[400,-40],[490,-70],[540,-150],[520,-240],[440,-290],[340,-300],[250,-340],[160,-330],[80,-370],[-10,-360],[-80,-310],[-100,-230],[-170,-190],[-260,-200],[-340,-250],[-440,-260],[-520,-210],[-540,-120],[-490,-50],[-400,-20],[-290,-15],[-180,-30],[-90,-10],[-40,0]]) },

{ id:'mexico', round:20, name:'Aut. Hermanos Rodriguez', gp:'Mexico City GP', country:'Mexico', laps:5, width:13,
  points:P([[0,0],[220,-6],[430,-15],[560,-50],[610,-130],[570,-210],[480,-240],[390,-215],[310,-250],[220,-260],[140,-220],[100,-150],[30,-115],[-60,-130],[-130,-180],[-220,-200],[-310,-170],[-350,-95],[-320,-20],[-380,40],[-430,110],[-390,180],[-300,200],[-200,180],[-110,140],[-40,80],[-10,30]]) },

{ id:'brazil', round:21, name:'Interlagos', gp:'São Paulo GP', country:'Brazil', laps:5, width:13,
  points:P([[0,0],[160,-10],[280,-50],[340,-130],[320,-215],[240,-260],[150,-250],[80,-290],[70,-370],[140,-420],[250,-425],[350,-385],[420,-305],[460,-215],[470,-115],[430,-30],[350,20],[250,30],[150,70],[60,120],[-40,140],[-150,130],[-240,90],[-290,10],[-280,-70],[-200,-95],[-110,-70],[-50,-30]]) },

{ id:'vegas', round:22, name:'Las Vegas Strip', gp:'Las Vegas GP', country:'USA', laps:4, width:13,
  points:P([[0,0],[240,-8],[480,-16],[660,-30],[760,-90],[770,-180],[700,-230],[600,-225],[520,-260],[420,-270],[330,-235],[290,-160],[220,-125],[130,-145],[50,-115],[20,-75],[-60,-55],[-150,-70],[-240,-45],[-330,-60],[-420,-35],[-480,30],[-470,120],[-390,170],[-290,165],[-190,150],[-90,140],[-20,90],[0,40]]) },

{ id:'qatar', round:23, name:'Lusail Intl.', gp:'Qatar GP', country:'Qatar', laps:5, width:14,
  points:P([[0,0],[200,-6],[380,-20],[490,-70],[520,-155],[470,-230],[380,-255],[290,-230],[210,-260],[110,-270],[20,-235],[-40,-165],[-120,-135],[-210,-155],[-290,-120],[-320,-40],[-290,35],[-210,70],[-120,60],[-40,95],[40,140],[140,160],[250,150],[340,110],[380,45],[330,35],[240,40],[120,28]]) },

{ id:'abudhabi', round:24, name:'Yas Marina', gp:'Abu Dhabi GP', country:'UAE', laps:4, width:13,
  points:P([[0,0],[200,-8],[380,-25],[480,-80],[500,-170],[440,-235],[340,-250],[240,-225],[150,-255],[50,-260],[-40,-225],[-100,-155],[-180,-120],[-270,-135],[-350,-95],[-370,-10],[-320,60],[-230,85],[-130,75],[-50,110],[30,160],[130,185],[240,175],[330,135],[380,70],[340,40],[200,38],[20,42],[-110,22],[-55,-10]]) },
];

// ---- merge real circuit data + assign visual themes ----
const TRACK_THEMES = {
  bahrain:'desertNight', qatar:'desertNight', abudhabi:'desertNight',
  saudi:'streetNight', singapore:'streetNight', vegas:'streetNight',
  miami:'streetDay', monaco:'streetDay', madrid:'streetDay', azerbaijan:'streetDay',
  belgium:'forest', italy:'forest', japan:'forest', austria:'forest',
  netherlands:'dunes',
};
// characteristic elevation amplitude (m) — real circuits' vertical identity
const TRACK_ELEV = {
  belgium: 34, austria: 24, brazil: 18, usa: 17, japan: 14, hungary: 10,
  britain: 6, spain: 9, mexico: 4, netherlands: 6, monaco: 12, azerbaijan: 6,
  canada: 3, australia: 4, china: 5, bahrain: 6, italy: 4, madrid: 8,
  saudi: 2, miami: 3, singapore: 2, vegas: 2, qatar: 2, abudhabi: 3,
};

// real full-race lap counts (laps stays the short arcade default)
const TRACK_FULL_LAPS = {
  australia: 58, china: 56, japan: 53, bahrain: 57, saudi: 50, miami: 57,
  canada: 70, monaco: 78, spain: 66, austria: 71, britain: 52, belgium: 44,
  hungary: 70, netherlands: 72, italy: 53, madrid: 56, azerbaijan: 51,
  singapore: 62, usa: 56, mexico: 71, brazil: 71, vegas: 50, qatar: 57, abudhabi: 58,
};

// DRS zone counts per circuit (matches the current real-world F1 layouts);
// zones are auto-placed on each track's longest straights.
const TRACK_DRS = {
  australia:4, china:2, japan:1, bahrain:3, saudi:3, miami:3, canada:3, monaco:1,
  spain:2, austria:3, britain:2, belgium:2, hungary:2, netherlands:2, italy:2,
  madrid:3, azerbaijan:2, singapore:3, usa:2, mexico:3, brazil:2, vegas:2,
  qatar:1, abudhabi:2,
};

// recommended number of stops over a full race distance — high-degradation,
// abrasive circuits favour two stops; street tracks where overtaking is hard
// favour one. Scaled down automatically for shorter race distances.
const TRACK_STOPS = {
  australia:1, china:2, japan:2, bahrain:2, saudi:1, miami:1, canada:1, monaco:1,
  spain:2, austria:2, britain:2, belgium:1, hungary:2, netherlands:2, italy:1,
  madrid:1, azerbaijan:1, singapore:1, usa:2, mexico:2, brazil:2, vegas:1,
  qatar:2, abudhabi:1,
};

// real-world race direction: these 8 run anticlockwise, all others clockwise
const ACW_TRACKS = { usa:1, miami:1, azerbaijan:1, singapore:1, vegas:1, brazil:1, abudhabi:1, saudi:1 };

// per-circuit chance a session sees some rain (realistic climatology)
const TRACK_RAIN = {
  belgium:0.40, brazil:0.40, japan:0.40, britain:0.40, hungary:0.40, netherlands:0.40, singapore:0.40,
  austria:0.20, canada:0.20, italy:0.20, usa:0.20, china:0.20, monaco:0.20, madrid:0.20, spain:0.20, mexico:0.20, australia:0.20,
  bahrain:0.02, saudi:0.02, qatar:0.02, abudhabi:0.02, vegas:0.02, azerbaijan:0.02, miami:0.02,
};

TRACKS.forEach(t => {
  t.theme = TRACK_THEMES[t.id] || 'green';
  t.elev = TRACK_ELEV[t.id] != null ? TRACK_ELEV[t.id] : 6;
  t.drs = TRACK_DRS[t.id] || 2;
  t.recStops = TRACK_STOPS[t.id] != null ? TRACK_STOPS[t.id] : 1;
  t.fullLaps = TRACK_FULL_LAPS[t.id] != null ? TRACK_FULL_LAPS[t.id] : t.laps;
  t.rainChance = TRACK_RAIN[t.id] != null ? TRACK_RAIN[t.id] : 0.15;
  if (typeof REAL_TRACKS !== 'undefined' && REAL_TRACKS[t.id]) {
    const r = REAL_TRACKS[t.id];
    // TUM data is east/north (y = north): negate into our z-south world,
    // otherwise the layout renders as a mirror image.
    const TUM = { australia:1, china:1, japan:1, bahrain:1, canada:1, spain:1, austria:1,
      britain:1, belgium:1, hungary:1, netherlands:1, italy:1, usa:1, mexico:1, brazil:1, abudhabi:1 };
    t.points = TUM[t.id]
      ? r.pts.map(p => ({ x: p[0], z: -p[1] }))
      : r.pts.map(p => ({ x: p[0], z: p[1] }));
    t.width = Math.max(10.5, Math.min(15, r.w));
    t.realData = true;
  }
  // enforce correct direction of travel (signed area: >0 = clockwise on the map)
  let A = 0;
  for (let i = 0; i < t.points.length; i++) {
    const a = t.points[i], b = t.points[(i+1) % t.points.length];
    A += a.x*b.z - b.x*a.z;
  }
  const visualCW = A > 0;
  const wantCW = !ACW_TRACKS[t.id];
  if (visualCW !== wantCW) {
    t.points = t.points.slice().reverse();
    t.points.unshift(t.points.pop()); // keep the same start/finish point
  }
});

// start/finish corrections: rotate the loop forward so index 0 sits on the
// pit straight before the real Turn 1. monaco:104 → S/F on the left edge with
// ~175m up to Sainte Devote (the front-left 90° right-hander), as on the map.
const START_SHIFT = { monaco: 104 };
Object.keys(START_SHIFT).forEach(id => {
  const t = TRACKS.find(x => x.id === id);
  if (!t) return;
  const s = START_SHIFT[id];
  t.points = t.points.slice(s).concat(t.points.slice(0, s));
});
