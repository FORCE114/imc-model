import * as THREE from 'three';

// Photo-based display derivative. Depth is illustrative, not a surveyed level.
export function createExcavation(corners) {
  const root = new THREE.Group(); root.name = 'IMC excavation — photo reference';
  const depth = 4.2;
  const inner = corners.map(([x,y]) => new THREE.Vector2(x * 0.965, y * 0.965));
  const shape = new THREE.Shape(inner);
  const floorGeometry = new THREE.ShapeGeometry(shape);
  const uv = floorGeometry.attributes.uv, pos = floorGeometry.attributes.position;
  for(let i=0;i<uv.count;i++) uv.setXY(i,pos.getX(i)/12,pos.getY(i)/12);
  const loader = new THREE.TextureLoader();
  const soil = loader.load('assets/soil/sandy_gravel_diff_1k.jpg');
  soil.colorSpace = THREE.SRGBColorSpace; soil.wrapS = soil.wrapT = THREE.RepeatWrapping;
  const normal = loader.load('assets/soil/sandy_gravel_nor_gl_1k.jpg');
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  const earth = new THREE.MeshStandardMaterial({map:soil,normalMap:normal,normalScale:new THREE.Vector2(.35,.35),color:0xb6a389,roughness:1,side:THREE.DoubleSide});
  const floor = new THREE.Mesh(floorGeometry, earth); floor.rotation.x=-Math.PI/2; floor.position.y=-depth; root.add(floor);
  const concrete = new THREE.MeshStandardMaterial({color:0x9b978b,roughness:1});
  const lower = new THREE.MeshStandardMaterial({color:0x968875,map:soil,roughness:1});
  const dark = new THREE.MeshStandardMaterial({color:0x303331,roughness:.9});
  const steel = new THREE.MeshStandardMaterial({color:0x66615a,roughness:.85});
  function beam(a,b,y,w,h,mat) {
    const dx=b.x-a.x, dy=b.y-a.y, length=Math.hypot(dx,dy);
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(length,h,w),mat);
    mesh.position.set((a.x+b.x)/2,y,-(a.y+b.y)/2); mesh.rotation.y=Math.atan2(dy,dx); root.add(mesh); return mesh;
  }
  for(let i=0;i<inner.length;i++) {
    const a=inner[i], b=inner[(i+1)%inner.length];
    beam(a,b,-3.35,.75,1.7,lower);
    beam(a,b,-1.25,.7,2.5,concrete);
    beam(a,b,.06,1.15,.22,concrete);
    beam(a,b,-1.6,.85,.20,steel);
    beam(a,b,1.4,.12,2.65,dark);
    const n=Math.ceil(a.distanceTo(b)/2.5);
    for(let j=0;j<=n;j++) {const p=a.clone().lerp(b,j/n);const post=new THREE.Mesh(new THREE.BoxGeometry(.11,2.9,.16),steel);post.position.set(p.x,1.4,-p.y);root.add(post);}
    for(const y of [.55,2.35]) beam(a,b,y,.18,.08,steel);
  }
  // Deterministic shallow spoil mounds and scattered aggregate.
  let seed=812; const rand=()=>((seed=(1664525*seed+1013904223)>>>0)/4294967296);
  function inside(x,y){let odd=false;for(let i=0,j=inner.length-1;i<inner.length;j=i++){const a=inner[i],b=inner[j];if((a.y>y)!=(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)odd=!odd;}return odd;}
  const stones=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,0),lower,450);
  const helper=new THREE.Object3D();
  for(let i=0;i<450;i++){let x,y;do{x=(rand()-.5)*92;y=(rand()-.5)*115;}while(!inside(x,y));const s=.08+rand()*.32;helper.position.set(x,-depth+s*.3,-y);helper.scale.set(s*1.4,s*.7,s);helper.rotation.set(rand()*3,rand()*6,rand()*3);helper.updateMatrix();stones.setMatrixAt(i,helper.matrix);}root.add(stones);
  for(const [x,y,r] of [[12,-22,4.2],[-9,17,3.4],[3,-5,2.2]]){const mound=new THREE.Mesh(new THREE.SphereGeometry(r,14,8),earth);mound.scale.y=.18;mound.position.set(x,-depth-.15,-y);root.add(mound);}
  // Paired machine tracks following the long axis of the site.
  const trackMat=new THREE.MeshStandardMaterial({color:0x887760,roughness:1,transparent:true,opacity:.32,depthWrite:false});
  const direction=new THREE.Vector2(61.08,-93.54).normalize(), across=new THREE.Vector2(-direction.y,direction.x);
  const tracks=new THREE.InstancedMesh(new THREE.PlaneGeometry(.8,.14),trackMat,1000);
  let trackCount=0;helper.scale.set(1,1,1);
  for(const lane of [-12,4,15])for(const offset of [-1.15,1.15])for(let t=-43;t<42;t+=.55){const p=direction.clone().multiplyScalar(t).addScaledVector(across,lane+offset);if(!inside(p.x,p.y))continue;helper.rotation.set(-Math.PI/2,0,Math.atan2(direction.y,direction.x)+Math.PI/2);helper.position.set(p.x,-depth+.018,-p.y);helper.updateMatrix();tracks.setMatrixAt(trackCount++,helper.matrix);}
  tracks.count=trackCount;root.add(tracks);
  root.userData={depthMetres:depth,approximate:true,reference:'EXCAVATION/Slide1.JPG, Slide5.JPG, WhatsApp detail photos'};
  return root;
}

export function createMapWithOpening(rect,corners,material) {
  const outline = new THREE.Shape([new THREE.Vector2(rect.min[0],rect.min[1]),new THREE.Vector2(rect.max[0],rect.min[1]),new THREE.Vector2(rect.max[0],rect.max[1]),new THREE.Vector2(rect.min[0],rect.max[1])]);
  outline.holes.push(new THREE.Path(corners.map(([x,y])=>new THREE.Vector2(x*.965,y*.965))));
  const geometry=new THREE.ShapeGeometry(outline),p=geometry.attributes.position,uv=geometry.attributes.uv;
  for(let i=0;i<uv.count;i++)uv.setXY(i,(p.getX(i)-rect.min[0])/rect.size[0],(p.getY(i)-rect.min[1])/rect.size[1]);
  const mesh=new THREE.Mesh(geometry,material);mesh.rotation.x=-Math.PI/2;return mesh;
}
