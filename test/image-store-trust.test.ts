import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveSessionImages, resetImageRestoreForTests, resolveImageRestore, pruneRetrieveImgExports } from '../src/context/image-restore.ts';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const oldHome=process.env.HOME, oldDsh=process.env.DSH_HOME;let roots: string[]=[];
function setup(){const base=mkdtempSync(join(tmpdir(),'cursor-image-independent-'));roots.push(base);const home=join(base,'home'),project=join(base,'project'),dsh=join(home,'.dsh');mkdirSync(dsh,{recursive:true});mkdirSync(project);process.env.HOME=home;process.env.DSH_HOME=dsh;resetImageRestoreForTests();return {base,home,project,dsh};}
function files(root: string){return existsSync(root)?readdirSync(root,{recursive:true}).map(String).sort():[];}
function archive(sessionId: string,project: string){return archiveSessionImages({sessionId,sessionRoot:project,messages:[{role:'user',content:[{type:'image',data:PNG,mimeType:'image/png'}]}],refs:[{index:0,ref:'m00001'}]});}
afterEach(()=>{resetImageRestoreForTests();for(const p of roots)rmSync(p,{recursive:true,force:true});roots=[];if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldDsh===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldDsh;});

test('independent: plugin store ancestor symlink must not redirect writes into project',()=>{
 const{project,dsh}=setup();symlinkSync(project,join(dsh,'cursor-to-dsh'));
 const notes=archive('session-A',project);const observed=files(project);
 console.log(JSON.stringify({case:'plugin-store-ancestor-symlink',projectEntries:observed,restorable:notes.map(n=>n.restorable)}));
 assert.deepEqual(observed,[],'image and index writes followed plugin-root symlink into project');
});

test('independent: DSH_HOME symlink must not redirect writes into project',()=>{
 const{home,project}=setup();const alias=join(home,'home-alias');symlinkSync(project,alias);process.env.DSH_HOME=alias;
 archive('session-A',project);const observed=files(project);
 console.log(JSON.stringify({case:'dsh-home-symlink',projectEntries:observed}));
 assert.deepEqual(observed,[],'image and index writes followed DSH_HOME symlink into project');
});

test('independent: legacy index claiming a different session must not be bypassed by filename rebuild',()=>{
 const{project}=setup();const dir=join(project,'.dsh','retrieve','img','session-A');mkdirSync(dir,{recursive:true});
 const image=join(dir,'m00001-deadbeef.png');writeFileSync(image,Buffer.from(PNG,'base64'));
 writeFileSync(join(dir,'index.json'),JSON.stringify({sessionId:'session-B',images:{m00001:[{mediaType:'image/png',bytes:1,path:image}]}}));
 const result=resolveImageRestore({sessionId:'session-A',imageRef:'m00001',sessionRoot:project});
 console.log(JSON.stringify({case:'foreign-owner-legacy-index',ok:result.ok,images:result.images}));
 assert.equal(result.ok,false,'explicit foreign session ownership was ignored during fallback rebuild');
});

test('independent: verified same-session legacy image stays read-only and default archives stay outside project',()=>{
 const{project,dsh}=setup();const dir=join(project,'.dsh','retrieve','img','session-A');mkdirSync(dir,{recursive:true});
 const image=join(dir,'m00009-deadbeef.png');writeFileSync(image,Buffer.from(PNG,'base64'));
 const index=join(dir,'index.json');writeFileSync(index,JSON.stringify({sessionId:'session-A',images:{m00009:[{mediaType:'image/png',bytes:1,path:image}]}}));
 const before=readFileSync(index,'utf8');const beforeFiles=files(project);
 assert.equal(resolveImageRestore({sessionId:'session-A',imageRef:'m00009',sessionRoot:project}).ok,true);
 archive('session-A',project);
 assert.equal(readFileSync(index,'utf8'),before);assert.deepEqual(files(project),beforeFiles);
 assert.ok(files(dsh).some(p=>p.includes('cursor-to-dsh/retrieve/img/session-A')));
});


test('independent: redirected plugin root must not TTL-delete pre-existing legacy project images',()=>{
 const{project,dsh}=setup();const oldRoot=join(project,'.dsh');const bucket=join(oldRoot,'retrieve','img','session-A');mkdirSync(bucket,{recursive:true});
 const oldImage=join(bucket,'m00001-deadbeef.png');writeFileSync(oldImage,Buffer.from(PNG,'base64'));const past=new Date(Date.now()-10*24*3600*1000);utimesSync(oldImage,past,past);
 symlinkSync(oldRoot,join(dsh,'cursor-to-dsh'));
 const removed=pruneRetrieveImgExports('session-A',project);
 console.log(JSON.stringify({case:'legacy-project-ttl-via-plugin-root-symlink',removed,oldImageStillExists:existsSync(oldImage)}));
 assert.equal(removed,0,'TTL followed plugin-store ancestor link and deleted legacy project cache');assert.equal(existsSync(oldImage),true);
});

// Additional trust-boundary cases beyond the original independent blockers.
for (const segments of [['cursor-to-dsh'], ['cursor-to-dsh','retrieve'], ['cursor-to-dsh','retrieve','img']]) {
 test(`trust: reject every plugin-store ancestor alias (${segments.join('/')}) before creating anything`,()=>{
  const{project,dsh}=setup();const parent=join(dsh,...segments.slice(0,-1));mkdirSync(parent,{recursive:true});symlinkSync(project,join(dsh,...segments));
  assert.equal(archive('session-A',project).some(n=>n.restorable),false);
  assert.deepEqual(files(project),[]);
  assert.equal(pruneRetrieveImgExports('session-A',project),0);
  assert.deepEqual(files(project),[]);
 });
}

test('trust: explicit absolute DSH_HOME inside a project under HOME is refused without mkdir',()=>{
 const{home,project}=setup();const inside=join(home,'work','project');mkdirSync(inside,{recursive:true});
 process.env.DSH_HOME=join(inside,'private-cache');archive('session-A',inside);
 assert.deepEqual(files(inside),[]);
 assert.equal(pruneRetrieveImgExports('session-A',inside),0);
});

test('trust: external absolute DSH_HOME fails closed rather than creating a new trusted root',()=>{
 const{base,project}=setup();const external=join(base,'external-data');process.env.DSH_HOME=external;
 assert.equal(archive('session-A',project).some(n=>n.restorable),false);
 assert.equal(existsSync(external),false);
});

test('trust: canonical HOME alias supports normal user/system path spellings without accepting child aliases',()=>{
 const{base,home,project}=setup();const systemAlias=join(base,'system-home-alias');symlinkSync(home,systemAlias);
 process.env.HOME=systemAlias;process.env.DSH_HOME=join(systemAlias,'.dsh');
 assert.equal(archive('session-A',project).some(n=>n.restorable),true);
 const got=resolveImageRestore({sessionId:'session-A',imageRef:'m00001',sessionRoot:project});
 assert.equal(got.ok,true);
 assert.ok(got.images![0].path.startsWith(join(realpathSync(home),'.dsh')));
 assert.deepEqual(files(project),[]);
});

test('trust: explicit foreign-owner primary index rejects read, write and TTL without rebuilding',()=>{
 const{dsh,project}=setup();const dir=join(dsh,'cursor-to-dsh','retrieve','img','session-A');mkdirSync(dir,{recursive:true});
 const image=join(dir,'m00001-deadbeef.png');writeFileSync(image,Buffer.from(PNG,'base64'));
 const index=join(dir,'index.json');const content=JSON.stringify({sessionId:'session-B',images:{}});writeFileSync(index,content);
 const past=new Date(Date.now()-10*24*3600*1000);utimesSync(image,past,past);
 assert.equal(resolveImageRestore({sessionId:'session-A',imageRef:'m00001',sessionRoot:project}).ok,false);
 assert.equal(archive('session-A',project).some(n=>n.restorable),false);
 assert.equal(pruneRetrieveImgExports('session-A',project),0);
 assert.equal(readFileSync(index,'utf8'),content);assert.equal(existsSync(image),true);
});

test('trust: truncated or missing-owner legacy indexes do not authorize filename scanning',()=>{
 const{project}=setup();const dir=join(project,'.dsh','retrieve','img','session-A');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'m00001-deadbeef.png'),Buffer.from(PNG,'base64'));
 for(const content of ['{',JSON.stringify({images:{}})]) {
  writeFileSync(join(dir,'index.json'),content);resetImageRestoreForTests();
  assert.equal(resolveImageRestore({sessionId:'session-A',imageRef:'m00001',sessionRoot:project}).ok,false);
 }
});

test('trust: root revalidation is not bypassed by a previously loaded session index',()=>{
 const{project,dsh}=setup();archive('session-A',project);
 assert.equal(resolveImageRestore({sessionId:'session-A',imageRef:'m00001',sessionRoot:project}).ok,true);
 const alias=join(dsh,'different-root');symlinkSync(project,alias);process.env.DSH_HOME=alias;
 assert.equal(resolveImageRestore({sessionId:'session-A',imageRef:'m00001',sessionRoot:project}).ok,false);
 assert.equal(archive('session-A',project).some(n=>n.restorable),false);assert.deepEqual(files(project),[]);
});

test('trust: default ~/.dsh symlink cannot redirect backup or TTL into a project',()=>{
 const{home,project,dsh}=setup();rmSync(dsh,{recursive:true});symlinkSync(project,dsh);delete process.env.DSH_HOME;
 assert.equal(archive('session-A',project).some(n=>n.restorable),false);
 assert.equal(pruneRetrieveImgExports('session-A',project),0);assert.deepEqual(files(project),[]);
});

test('trust: a former project remains ineligible after the active cwd changes',()=>{
 const{home,project}=setup();const old=join(home,'old-project');mkdirSync(old);
 archive('session-A',old);process.env.DSH_HOME=join(old,'.dsh');
 assert.equal(archive('session-B',project).some(n=>n.restorable),false);
 assert.equal(pruneRetrieveImgExports('session-B',project),0);assert.deepEqual(files(old),[]);
});
