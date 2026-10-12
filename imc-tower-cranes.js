import * as THREE from 'three';

// Diagram traced in image pixels against the approximately 108 x 50 m BIM footprint.
// Positions, radii and heights are presentation estimates, not a lifting design.
export const craneDefinitions = [
  { id: 'TC-01', x: 32.5, z: 38, height: 50, radius: 70, heading: 120, colour: '#f0b429' },
];

export function createTowerCranes() {
  const root = new THREE.Group(); root.name = 'IMC tower cranes (diagram estimates)';
  const ranges = new THREE.Group(); ranges.name = '70 m reference working radius';
  const solids = new THREE.Group(); solids.name = 'Tower crane geometry';
  root.add(solids, ranges);
  const yellow = new THREE.MeshStandardMaterial({color:'#e8b128',roughness:.62,metalness:.2});
  const steel = new THREE.MeshStandardMaterial({color:'#424b53',roughness:.65,metalness:.35});
  const concrete = new THREE.MeshStandardMaterial({color:'#adb0ad',roughness:.9});
  const glazing = new THREE.MeshStandardMaterial({color:'#24617a',roughness:.25,metalness:.3});
  const rodGeometry = new THREE.CylinderGeometry(1,1,1,6);
  const boxGeometry = new THREE.BoxGeometry(1,1,1);
  const batches = new Map();
  function queue(geometry, material, matrix) {
    const key=geometry.uuid+material.uuid;
    if(!batches.has(key)) batches.set(key,{geometry,material,matrices:[]});
    batches.get(key).matrices.push(matrix);
  }
  function beam(a,b,r,mat=yellow) {
    const from=new THREE.Vector3(...a),to=new THREE.Vector3(...b),delta=to.clone().sub(from);
    queue(rodGeometry,mat,new THREE.Matrix4().compose(from.add(to).multiplyScalar(.5),new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),delta.clone().normalize()),new THREE.Vector3(r,delta.length(),r)));
  }
  function box(pos,size,mat,angle=0) {
    queue(boxGeometry,mat,new THREE.Matrix4().compose(new THREE.Vector3(...pos),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),angle),new THREE.Vector3(...size)));
  }
  function label(c) {
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=80;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#18384b';ctx.fillRect(0,0,256,80);
    ctx.fillStyle=c.colour;ctx.fillRect(0,0,10,80);ctx.fillStyle='white';ctx.textAlign='center';ctx.font='bold 34px Arial';ctx.fillText(c.id+' · '+c.radius+' m',132,52);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:false,toneMapped:false}));
    sprite.position.set(c.x,c.height+11,c.z);sprite.scale.set(15,4.7,1);solids.add(sprite);
  }
  for(const c of craneDefinitions) {
    const h=c.height, half=1.15;
    const point=(x,y,z)=>[c.x+x,y,c.z+z];
    box(point(0,.3,0),[5.8,.6,5.8],concrete);
    for(const x of [-half,half]) for(const z of [-half,half]) beam(point(x,.6,z),point(x,h,z),.13);
    for(let y=.7;y<h-1;y+=4) {
      const next=Math.min(y+4,h);
      for(const z of [-half,half]) {
        beam(point(-half,y,z),point(half,y,z),.085);
        beam(point(-half,y,z),point(half,next,z),.065);
        beam(point(half,y,z),point(-half,next,z),.065);
      }
      for(const x of [-half,half]) {
        beam(point(x,y,-half),point(x,y,half),.085);
        beam(point(x,y,-half),point(x,next,half),.065);
        beam(point(x,y,half),point(x,next,-half),.065);
      }
    }
    box(point(0,h,0),[4.2,.45,3.5],yellow);
    const a=THREE.MathUtils.degToRad(c.heading),cos=Math.cos(a),sin=Math.sin(a);
    const jib=(u,y,v)=>point(u*cos-v*sin,y,u*sin+v*cos);
    for(let u=-14;u<c.radius;u+=4) {
      const end=Math.min(u+4,c.radius);
      for(const v of [-.8,.8]) {
        beam(jib(u,h,v),jib(end,h,v),.09);
        beam(jib(u,h,v),jib(end,h+1.8,0),.07);
        beam(jib(u,h+1.8,0),jib(end,h,v),.07);
      }
      beam(jib(u,h+1.8,0),jib(end,h+1.8,0),.09);
      beam(jib(u,h,-.8),jib(u,h,.8),.065);
    }
    for(const v of [-.8,.8]) beam(jib(-1,h,v),jib(0,h+7,0),.13);
    beam(jib(0,h+7,0),jib(43,h+1.8,0),.035,steel);
    beam(jib(0,h+7,0),jib(-13,h+1.8,0),.045,steel);
    box(jib(-11,h+1.4,0),[4,2.8,2.5],concrete,-a);
    box(jib(2,h-1.2,1.7),[2.4,2.6,1.8],yellow,-a);
    box(jib(2,h-.9,2.65),[1.8,1.65,.07],glazing,-a);
    box(jib(40,h-.4,0),[1.5,.55,1.9],steel,-a);
    // Idle hook above roof level; no simulated load or collision clearance claim.
    beam(jib(40,h-.5,-.15),jib(40,40,-.15),.025,steel);
    beam(jib(40,h-.5,.15),jib(40,40,.15),.025,steel);
    box(jib(40,39.5,0),[.65,1,.65],steel);
    const arc=[];for(let i=0;i<=192;i++){const theta=i/192*Math.PI*2;arc.push(new THREE.Vector3(c.x+c.radius*Math.cos(theta),.45,c.z+c.radius*Math.sin(theta)));}
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc),new THREE.LineBasicMaterial({color:c.colour,transparent:true,opacity:.85,toneMapped:false}));
    ranges.add(line); label(c);
  }
  for(const {geometry,material,matrices} of batches.values()) {
    const instanced=new THREE.InstancedMesh(geometry,material,matrices.length);
    matrices.forEach((matrix,i)=>instanced.setMatrixAt(i,matrix));instanced.computeBoundingSphere();solids.add(instanced);
  }
  const bounds=new THREE.Box3();
  for(const c of craneDefinitions){bounds.expandByPoint(new THREE.Vector3(c.x-c.radius,0,c.z-c.radius));bounds.expandByPoint(new THREE.Vector3(c.x+c.radius,c.height+12,c.z+c.radius));}
  return {root,solids,ranges,bounds,definitions:craneDefinitions};
}
