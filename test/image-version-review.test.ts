import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, utimesSync, existsSync, readFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSessionImages, resetImageRestoreForTests, resolveImageRestore, pruneRetrieveImgExports, restoreExportDir } from "../src/context/image-restore.ts";
const PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const GIF="R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const oldHome=process.env.HOME,oldDsh=process.env.DSH_HOME;
let root:string|undefined;
function setup(){root=mkdtempSync(join(tmpdir(),"cursor-image-version-review-"));const home=join(root,"home"),project=join(home,"project");mkdirSync(project,{recursive:true});process.env.HOME=home;process.env.DSH_HOME=join(home,".dsh");resetImageRestoreForTests();return {home,project};}
function archive(data:string,mimeType:string,project:string){archiveSessionImages({sessionId:"session-A",sessionRoot:project,messages:[{role:"user",content:[{type:"image",data,mimeType}]}],refs:[{ref:"m00001",index:0}]});return resolveImageRestore({sessionId:"session-A",imageRef:"m00001",sessionRoot:project}).images![0].path;}
afterEach(()=>{resetImageRestoreForTests();if(root)rmSync(root,{recursive:true,force:true});if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldDsh===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldDsh;});

test("review: TTL of authoritative image must not resurrect an older pixel version",()=>{
 const {project}=setup();const older=archive(PNG,"image/png",project);const current=archive(GIF,"image/gif",project);
 const past=new Date(Date.now()-10*24*3600*1000);utimesSync(current,past,past);
 assert.equal(pruneRetrieveImgExports("session-A",project),1);assert.equal(existsSync(older),true);
 resetImageRestoreForTests();const got=resolveImageRestore({sessionId:"session-A",imageRef:"m00001",sessionRoot:project});
 assert.equal(got.ok,false,"a valid latest-version index must not be erased and rebuilt from leftover historical pixels");
});

test("review: missing authoritative primary image must not revive same-ref legacy pixels",()=>{
 const {project}=setup();const dir=join(project,".dsh","retrieve","img","session-A");mkdirSync(dir,{recursive:true});const legacy=join(dir,"m00001-deadbeef.png");writeFileSync(legacy,Buffer.from(PNG,"base64"));
 writeFileSync(join(dir,"index.json"),JSON.stringify({sessionId:"session-A",images:{m00001:[{path:legacy,mediaType:"image/png",bytes:1,index:0}]}}));
 const current=archive(GIF,"image/gif",project);unlinkSync(current);resetImageRestoreForTests();
 const got=resolveImageRestore({sessionId:"session-A",imageRef:"m00001",sessionRoot:project});
 assert.equal(got.ok,false,"primary ownership of a ref survives unavailable pixels; legacy must not fill it");assert.equal(existsSync(legacy),true);
});


test("review: legacy paths using an OS/HOME ancestor alias remain readable only within the verified bucket",()=>{
 const {home,project}=setup();const dir=join(project,".dsh","retrieve","img","session-A");mkdirSync(dir,{recursive:true});
 const alias=join(home,"os-alias");symlinkSync(project,alias);const image=join(dir,"m00009-deadbeef.png");writeFileSync(image,Buffer.from(PNG,"base64"));
 const aliasImage=join(alias,".dsh","retrieve","img","session-A","m00009-deadbeef.png");
 writeFileSync(join(dir,"index.json"),JSON.stringify({sessionId:"session-A",images:{m00009:[{path:aliasImage,mediaType:"image/png",bytes:1,index:0}]}}));
 const got=resolveImageRestore({sessionId:"session-A",imageRef:"m00009",sessionRoot:project});
 assert.equal(got.ok,true,"canonical containment should accept an alternate spelling of the same verified file");assert.equal(got.images![0].path,realpathSync(image));
 const foreign=join(home,"other.png");writeFileSync(foreign,Buffer.from(PNG,"base64"));
 writeFileSync(join(dir,"index.json"),JSON.stringify({sessionId:"session-A",images:{m00009:[{path:foreign,mediaType:"image/png",bytes:1,index:0}]}}));
 assert.equal(resolveImageRestore({sessionId:"session-A",imageRef:"m00009",sessionRoot:project}).ok,false,"canonical paths outside the verified bucket remain forbidden");
});
