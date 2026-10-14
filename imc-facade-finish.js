import * as THREE from 'three';

// Presentation materials sampled visually from the supplied 3D.png.
// Original GLB geometry, materials and batch metadata remain recoverable.
export function createFacadeFinish(renderer, scene) {
  const entries=[];const cache=new Map();const details=[];
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=128;
  const ctx=canvas.getContext('2d');const sky=ctx.createLinearGradient(0,0,0,128);
  sky.addColorStop(0,'#9cadc1');sky.addColorStop(.45,'#e3e5e6');sky.addColorStop(.52,'#ddd1b8');sky.addColorStop(1,'#7a7369');ctx.fillStyle=sky;ctx.fillRect(0,0,256,128);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.mapping=THREE.EquirectangularReflectionMapping;
  const pmrem=new THREE.PMREMGenerator(renderer);const target=pmrem.fromEquirectangular(texture);texture.dispose();pmrem.dispose();
  function finish(original,kind) {
    const key=original.uuid+kind;if(cache.has(key))return cache.get(key);
    const m=original.clone();m.name=original.name+' | reference '+kind;
    m.vertexColors=false;m.envMap=target.texture;m.envMapIntensity=.5;
    if(kind==='stone'){m.color.set('#a58f7e');m.roughness=.83;m.metalness=0;}
    if(kind==='cream'){m.color.set('#baad96');m.roughness=.86;m.metalness=0;}
    if(kind==='bronze'){m.color.set('#66503c');m.roughness=.53;m.metalness=.35;}
    if(kind==='frame'){m.color.set('#302923');m.roughness=.48;m.metalness=.4;}
    if(kind==='glass'){m.color.set('#222c38');m.roughness=.24;m.metalness=.32;m.transparent=false;m.opacity=1;m.depthWrite=true;m.envMapIntensity=1.05;}
    if(kind==='pattern'){m.color.set('#b9a385');m.roughness=.7;m.metalness=.15;}
    if(kind==='stone'||kind==='pattern') {
      m.onBeforeCompile=shader=>{
        shader.vertexShader='varying vec3 vFinishWorld;\n'+shader.vertexShader;
        shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\nvFinishWorld=(modelMatrix*vec4(transformed,1.0)).xyz;');
        shader.fragmentShader='varying vec3 vFinishWorld;\n'+shader.fragmentShader;
        const stone=`vec3 fn=normalize(cross(dFdx(vFinishWorld),dFdy(vFinishWorld)));
          vec2 uv=abs(fn.z)>abs(fn.x)?vFinishWorld.xy:vFinishWorld.zy;
          float row=floor(uv.y/0.45);uv.x+=mod(row,2.0)*0.45;
          vec2 tile=uv/vec2(.9,.45);vec2 cell=floor(tile);vec2 edge=min(fract(tile),1.0-fract(tile));
          float seam=1.0-smoothstep(.006,.022,min(edge.x,edge.y));
          float variation=fract(sin(dot(cell,vec2(12.9898,78.233)))*43758.5453);
          float grain=fract(sin(dot(floor(uv*90.0),vec2(41.7,289.1)))*45758.23);
          diffuseColor.rgb*=mix(.91,1.045,variation)*mix(.98,1.015,grain)*(1.0-seam*.17);`;
        // Mixed source group: bronze lattice below podium cornice, stone rooftop details above.
        const pattern=`float screenZone=1.0-smoothstep(18.7,19.5,vFinishWorld.y);
          diffuseColor.rgb*=mix(vec3(1.0),vec3(.25,.22,.19),screenZone);`;
        shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n'+(kind==='stone'?stone:pattern));
      };
      m.customProgramCacheKey=()=> 'imc-reference-'+kind+'-v2';
    }
    m.needsUpdate=true;cache.set(key,m);return m;
  }
  function register(root) {
    root.traverse(mesh=>{
      if(!mesh.isMesh)return;
      let category='',group='';for(let p=mesh;p;p=p.parent){category ||= p.userData.category||'';group ||= p.userData.groupId||'';}
      const originals=Array.isArray(mesh.material)?mesh.material:[mesh.material];let changed=false;
      const replacements=originals.map(mat=>{
        const token=String(mat.userData.materialToken||mat.name.match(/^material-(\d+)/)?.[1]||'');let kind=null;
        if(token==='67'&&category==='Walls')kind='stone';
        else if(token==='60'||(token==='56'&&category==='Walls'))kind='cream';
        else if(category==='Curtain Panels'&&['12','58','278'].includes(token))kind='glass';
        else if(category==='Windows'&&token==='12')kind='glass';
        else if(category==='Windows'&&['28','50','51'].includes(token))kind='frame';
        else if(category==='Curtain Wall Mullions'&&token==='13')kind='frame';
        else if(group==='group-00355')kind='pattern';
        if(!kind)return mat;changed=true;return finish(mat,kind);
      });
      if(changed) entries.push({mesh,original:mesh.material,themed:Array.isArray(mesh.material)?replacements:replacements[0]});
    });

  }
  function syncDetails(visible) {for(const d of details)d.visible=visible;}
  function apply(enabled) {for(const d of details)d.visible=enabled;for(const e of entries){e.mesh.material=enabled?e.themed:e.original;}}
  return {register,apply,syncDetails,snapshot:()=>({meshCount:entries.length,materialVariants:cache.size,presentationDetails:details.length,detailPositions:details.map(d=>d.getWorldPosition(new THREE.Vector3()).toArray())})};
}
