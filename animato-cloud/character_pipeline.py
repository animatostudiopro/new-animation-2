#!/usr/bin/env python3
"""AI character -> animation rig pipeline.

The pipeline deliberately generates one complete character first. A human-segmentation
mask + CelebAMask-HQ face parsing then cut the image into reusable transparent layers.
Only revealed areas are repaired with DreamShaper inpainting; the rest stays pixel-faithful
to the source image. The output is a compact cloud-rig manifest plus PNG layers.
"""
import argparse, json, math, os, sys, time, traceback, urllib.request
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

PARTS = {
    "background":0,"skin":1,"l_brow":2,"r_brow":3,"l_eye":4,"r_eye":5,"eyeglass":6,
    "l_ear":7,"r_ear":8,"earring":9,"nose":10,"mouth":11,"u_lip":12,"l_lip":13,
    "neck":14,"neck_l":15,"cloth":16,"hair":17,"hat":18,
}
FACE_MODEL_REPO = os.environ.get("CHARACTER_FACE_MODEL", "PayamFard123/dermaintel-face-parsing")
FACE_MODEL_FILE = os.environ.get("CHARACTER_FACE_MODEL_FILE", "resnet18.onnx")
INPAINT_MODEL = os.environ.get("CHARACTER_INPAINT_MODEL", "Lykon/dreamshaper-8-inpainting")
CACHE = Path(os.environ.get("CHARACTER_CACHE", str(Path.home()/".cache/animato-character")))


def log(msg): print(f"[character] {msg}", flush=True)


def load_pil(path_or_bytes):
    from PIL import Image
    if isinstance(path_or_bytes,(str,Path)): return Image.open(path_or_bytes).convert("RGBA")
    import io
    return Image.open(io.BytesIO(path_or_bytes)).convert("RGBA")


def download(url, out, max_bytes=20*1024*1024):
    req=urllib.request.Request(url, headers={"User-Agent":"Animato-Character-Rig/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r, open(out,"wb") as f:
        total=0
        while True:
            b=r.read(1024*1024)
            if not b: break
            total += len(b)
            if total>max_bytes: raise RuntimeError("source image is too large")
            f.write(b)
    return out


def subject_mask(img):
    """Best-effort human matting. rembg is preferred; if unavailable the face parser mask
    becomes the conservative foreground rather than inventing a bad silhouette."""
    try:
        from rembg import remove, new_session
        session = new_session("u2net_human_seg")
        out = remove(img, session=session, alpha_matting=False)
        return out.getchannel("A").convert("L")
    except Exception as e:
        log(f"human matting unavailable ({str(e)[:120]}) — using face/cloth silhouette fallback")
        return None


class FaceParser:
    def __init__(self):
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        CACHE.mkdir(parents=True, exist_ok=True)
        p = CACHE / FACE_MODEL_FILE
        if not p.exists():
            log("downloading the face parser weights…")
            src = hf_hub_download(repo_id=FACE_MODEL_REPO, filename=FACE_MODEL_FILE, cache_dir=str(CACHE))
            try: Path(src).replace(p)
            except Exception: p = Path(src)
        self.session = ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def parse(self, img):
        import numpy as np
        from PIL import Image
        rgb = img.convert("RGB").resize((512,512), Image.Resampling.BILINEAR)
        arr=np.asarray(rgb,dtype=np.float32)/255.0
        mean=np.array([0.485,0.456,0.406],np.float32); std=np.array([0.229,0.224,0.225],np.float32)
        arr=(arr-mean)/std
        x=arr.transpose(2,0,1)[None].astype(np.float32)
        y=self.session.run(None,{self.input:x})[0]
        if y.ndim==4: y=y[0]
        labels=np.argmax(y,axis=0).astype(np.uint8)
        # Resize using nearest-neighbour to source size.
        return Image.fromarray(labels,"L").resize(img.size, Image.Resampling.NEAREST)


def mask_for(labels, *names):
    from PIL import Image
    import numpy as np
    wanted={PARTS[n] for n in names}
    a=np.asarray(labels,dtype=np.uint8)
    out=np.isin(a,list(wanted)).astype(np.uint8)*255
    return Image.fromarray(out,"L")


def union(*masks):
    from PIL import ImageChops
    out=None
    for m in masks:
        if m is None: continue
        out=m if out is None else ImageChops.lighter(out,m)
    return out


def subtract(a,b):
    from PIL import ImageChops
    return ImageChops.subtract(a,b) if a is not None else None


def bbox(mask, pad=0):
    if mask is None: return None
    b=mask.getbbox()
    if not b: return None
    x0,y0,x1,y1=b; return (max(0,x0-pad),max(0,y0-pad),x1+pad,y1+pad)


def dilate(mask, px):
    from PIL import ImageFilter
    # MaxFilter must be odd. Large kernels are surprisingly expensive, so cap it.
    k=max(3,min(31,int(px)*2+1)); return mask.filter(ImageFilter.MaxFilter(k))


def extract(img, mask, out_file, pad=3):
    from PIL import Image
    b=bbox(mask,pad)
    if not b:
        return None
    layer=Image.new("RGBA",img.size,(0,0,0,0))
    layer.paste(img,(0,0),mask)
    layer=layer.crop(b)
    Path(out_file).parent.mkdir(parents=True,exist_ok=True)
    layer.save(out_file,"PNG",optimize=True,compress_level=6)
    return {"file":str(Path(out_file).as_posix()),"bbox":[b[0],b[1],b[2],b[3]],"width":b[2]-b[0],"height":b[3]-b[1]}


def inpaint_pipe():
    import torch
    from diffusers import StableDiffusionInpaintPipeline
    pipe=StableDiffusionInpaintPipeline.from_pretrained(INPAINT_MODEL, torch_dtype=torch.float32, safety_checker=None)
    pipe.set_progress_bar_config(disable=True); pipe.to("cpu")
    try: pipe.enable_attention_slicing()
    except Exception: pass
    return pipe


def inpaint_region(pipe, image, mask, prompt, seed=1, steps=None):
    """Small localized inpaint that only replaces pixels inside the repair mask.
    The original crop is restored outside the mask so the inpaint cannot repaint the
    user's background or hair that should remain untouched."""
    from PIL import Image, ImageFilter
    import torch
    b=bbox(mask,18)
    if not b: return image
    original_crop=image.crop(b).convert("RGB")
    original_size=original_crop.size
    original_mask=mask.crop(b).convert("L").filter(ImageFilter.GaussianBlur(1.2))
    crop=original_crop
    m=original_mask
    # Diffusers on CPU is happier with a 384–512ish canvas.
    max_side=512
    scale=min(1.0,max_side/max(crop.size))
    if scale<1:
        size=(max(256,int(crop.width*scale)//8*8), max(256,int(crop.height*scale)//8*8))
        crop=crop.resize(size,Image.Resampling.LANCZOS); m=m.resize(size,Image.Resampling.BILINEAR)
    gen=torch.Generator(device="cpu").manual_seed(int(seed)%(2**32))
    steps=int(steps or os.environ.get("CHARACTER_INPAINT_STEPS","20"))
    with torch.inference_mode():
        out=pipe(prompt=prompt, image=crop, mask_image=m, num_inference_steps=steps, guidance_scale=float(os.environ.get("CHARACTER_INPAINT_GUIDANCE","7")), generator=gen).images[0].convert("RGB")
    if out.size!=original_size:
        out=out.resize(original_size,Image.Resampling.LANCZOS)
    blended=original_crop.convert("RGBA")
    blended.paste(out.convert("RGBA"),(0,0),original_mask)
    base=image.copy(); base.paste(blended,(b[0],b[1])); return base


def cv_inpaint(image, mask):
    try:
        import cv2, numpy as np
        from PIL import Image
        rgb=np.array(image.convert("RGB")); mm=np.array(mask)
        fixed=cv2.inpaint(rgb,mm,3,cv2.INPAINT_TELEA)
        out=Image.fromarray(fixed).convert("RGBA"); out.putalpha(image.getchannel("A")); return out
    except Exception:
        return image


def split_eye_details(eye_mask, image):
    """Split each parsed eye into eyeball, iris and pupil masks.
    The face parser does not expose iris/pupil classes, so detect the darkest compact
    component near the eye centre and grow a conservative iris around it. This keeps
    the eye-white layer independent so the renderer's pupilX/pupilY logic can move it.
    """
    from PIL import Image, ImageDraw
    import numpy as np
    try:
        import cv2
    except Exception:
        cv2=None
    if eye_mask is None or not eye_mask.getbbox(): return eye_mask, None, None
    b=eye_mask.getbbox(); x0,y0,x1,y1=b
    w=max(1,x1-x0); h=max(1,y1-y0)
    eye=np.array(eye_mask.crop(b),dtype=np.uint8)
    rgb=np.array(image.convert('RGB').crop(b))
    if cv2 is not None:
        gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
        # Search the central eye region; exclude lashes/brows at the perimeter.
        cx0,cx1=int(w*.20),int(w*.80); cy0,cy1=int(h*.20),int(h*.80)
        roi=gray[cy0:cy1,cx0:cx1]
        if roi.size:
            threshold=float(np.percentile(roi,22))
            dark=((gray<=threshold).astype(np.uint8)*255)
            dark[:cy0]=0; dark[cy1:]=0; dark[:,:cx0]=0; dark[:,cx1:]=0
            dark=cv2.bitwise_and(dark,eye)
            n,lab,stats,cent=cv2.connectedComponentsWithStats(dark,8)
            candidates=[]
            for i in range(1,n):
                area=int(stats[i,cv2.CC_STAT_AREA])
                if 2<=area<=max(12,int(w*h*.12)):
                    cx,cy=cent[i]
                    candidates.append((abs(cx-w/2)+abs(cy-h/2),-area,i))
            if candidates:
                _,_,idx=sorted(candidates)[0]
                pupil_local=(lab==idx).astype(np.uint8)*255
            else: pupil_local=None
        else: pupil_local=None
    else: pupil_local=None
    if pupil_local is None:
        pupil_local=np.zeros((h,w),dtype=np.uint8)
        rr=max(2,int(min(w,h)*.09)); cx=int(w/2); cy=int(h/2)
        if cv2 is not None: cv2.circle(pupil_local,(cx,cy),rr,255,-1)
        else:
            d=ImageDraw.Draw(Image.fromarray(pupil_local)); d.ellipse((cx-rr,cy-rr,cx+rr,cy+rr),fill=255)
    # Iris is a soft ring around the pupil, clipped to the eye.
    if cv2 is not None:
        k=max(3,int(min(w,h)*.18)//2*2+1)
        iris_local=cv2.dilate(pupil_local,np.ones((k,k),np.uint8),iterations=1)
    else: iris_local=pupil_local
    eye_arr=eye
    iris_local=np.minimum(iris_local,eye_arr)
    pupil_local=np.minimum(pupil_local,iris_local)
    def full(local):
        m=Image.new('L',eye_mask.size,0); m.paste(Image.fromarray(local,'L'),(x0,y0)); return m
    return Image.fromarray(np.where(eye_arr>0,255,0).astype(np.uint8),'L').resize(eye_mask.size), full(iris_local), full(pupil_local)


def set_anchor_from_world_bbox(info, world_x, world_y):
    if not info or not info.get('bbox'): return {'anchorX':50,'anchorY':50}
    x0,y0,x1,y1=info['bbox']; w=max(1,x1-x0); h=max(1,y1-y0)
    return {'anchorX':max(0,min(100,((world_x-x0)/w)*100)), 'anchorY':max(0,min(100,((world_y-y0)/h)*100))}

def centered_geometry(parts,W,H):
    def pb(key):
        p=parts.get(key); return p.get("bbox") if p else None
    b=pb("head") or pb("face") or [W*0.25,H*0.12,W*0.75,H*0.52]
    fx=(b[0]+b[2])/2; fy=(b[1]+b[3])/2; fh=max(40,b[3]-b[1]); fw=max(40,b[2]-b[0])
    allb=pb("subject") or [0,0,W,H]
    top,feet=allb[1],allb[3]
    waist=top+(feet-top)*(0.68 if feet-top>fh*2 else 0.78)
    pelvis=top+(feet-top)*(0.63 if feet-top>fh*2 else 0.74)
    return {
      "frame":{"top":float(top),"pelvis":float(pelvis),"waist":float(waist),"feet":float(feet)},
      "headC":{"x":float(fx),"y":float(fy)}, "eyeY":float(fy-fh*.12), "browY":float(fy-fh*.24),
      "noseY":float(fy+fh*.06), "mouthY":float(fy+fh*.24), "earY":float(fy), "faceW":float(fw), "faceH":float(fh),
      "eyeDX":float(fw*.21), "eyeW":float(fw*.18), "eyeH":float(fh*.13), "irisR":float(max(3,fw*.04)),
      "shoulderY":float(b[3]+fh*.20), "shoulderX":float(fw*.78), "torsoW":float(fw*1.55), "torsoH":float(max(fh,waist-b[3])),
      "upperW":float(fw*.16), "foreW":float(fw*.14), "upperLen":float(fh*.68), "foreLen":float(fh*.62), "handLen":float(fh*.28)
    }


def vision_refine(img, geom):
    """Optional Gemini check: ask a vision model where the neck joint and shoulders are.
    Needs GEMINI_API_KEYS (comma separated). Any failure or implausible answer is ignored,
    so the geometry-based pivots stay in force."""
    keys=[k.strip() for k in os.environ.get("GEMINI_API_KEYS","").split(",") if k.strip()]
    if not keys: return None
    import base64, io, random
    small=img.convert("RGB"); small.thumbnail((768,768))
    buf=io.BytesIO(); small.save(buf,"JPEG",quality=85)
    model=os.environ.get("CHARACTER_VISION_MODEL","gemini-2.5-flash")
    prompt=("This is a front-facing character. Return ONLY JSON with normalized 0-1 image coordinates: "
            '{"neck_joint":{"x":..,"y":..},"shoulder_left":{"x":..,"y":..},"shoulder_right":{"x":..,"y":..}} '
            "where neck_joint is where the neck meets the torso/chest line, and shoulder_left/right are the shoulder joints "
            "on the image's left/right side.")
    body={"contents":[{"parts":[{"text":prompt},{"inline_data":{"mime_type":"image/jpeg","data":base64.b64encode(buf.getvalue()).decode()}}]}],
          "generationConfig":{"responseMimeType":"application/json","temperature":0}}
    try:
        url=f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={random.choice(keys)}"
        req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
        with urllib.request.urlopen(req,timeout=60) as r: data=json.loads(r.read())
        txt=data["candidates"][0]["content"]["parts"][0]["text"]
        j=json.loads(txt)
        W,H=img.size
        pts={k:(float(j[k]["x"])*W,float(j[k]["y"])*H) for k in ("neck_joint","shoulder_left","shoulder_right")}
        fh=geom["faceH"]
        # Plausibility: must be within ~1.2 face-heights of where geometry expects them.
        ex=geom["headC"]["x"]; ey=geom["shoulderY"]
        for k,(x,y) in pts.items():
            if abs(y-ey)>fh*1.2 or abs(x-ex)>geom["faceW"]*2.5: log(f"vision {k} implausible; ignored"); return None
        return pts
    except Exception as e:
        log(f"vision check skipped ({str(e)[:120]})"); return None


def part_def(pid,label,info,parent,z,tags):
    if not info: return None
    x0,y0,x1,y1=info["bbox"]; cx=(x0+x1)/2; cy=(y0+y1)/2; w=x1-x0; h=y1-y0
    return {"id":pid,"label":label,"tags":tags,"file":info["file"],"width":w,"height":h,
      "transform":{"x":cx,"y":cy,"rotation":0,"scaleX":1,"scaleY":1,"anchorX":50,"anchorY":50},
      "zIndex":z,"parentId":parent,"children":[],"isGroup":False,"isIndependent":True,"isVisible":True,"opacity":1}


def build(input_path,out_dir,mode,plan,gender,full_body,seed):
    from PIL import Image, ImageDraw, ImageChops
    out=Path(out_dir); parts_dir=out/"parts"; parts_dir.mkdir(parents=True,exist_ok=True)
    img=load_pil(input_path)
    # Keep dimensions bounded for CPU while preserving the user's image proportions.
    max_side=int(os.environ.get("CHARACTER_MAX_SIDE","1024"))
    scale=min(1,max_side/max(img.size))
    if scale<1: img=img.resize((max(1,int(img.width*scale)),max(1,int(img.height*scale))),Image.Resampling.LANCZOS)
    W,H=img.size
    alpha=subject_mask(img)
    parser=FaceParser(); labels=parser.parse(img)
    m={k:mask_for(labels,k) for k in PARTS if k!="background"}
    # Human silhouette: rembg is the preferred whole-person mask. When unavailable, build
    # a conservative silhouette from clothes/skin/neck/hair.
    if alpha is None:
        alpha=union(m["skin"],m["neck"],m["cloth"],m["hair"],m["l_ear"],m["r_ear"],m["hat"])
    alpha=dilate(alpha,1)

    face_all=union(m["skin"],m["l_brow"],m["r_brow"],m["l_eye"],m["r_eye"],m["nose"],m["mouth"],m["u_lip"],m["l_lip"],m["l_ear"],m["r_ear"])
    hb=face_all.getbbox() or (int(W*.2),int(H*.05),int(W*.8),int(H*.55))
    face_y0,face_y1=hb[1],hb[3]
    hair=m["hair"]
    # Front hair = fringe/bangs over the forehead; side/back hair stays with the back layer.
    hf=hair.copy()
    cut_y=int(face_y0+(face_y1-face_y0)*0.22)
    band=Image.new("L",(W,H),0); ImageDraw.Draw(band).rectangle([0,cut_y,W,H],fill=255)
    hair_front=ImageChops.multiply(hair,band)
    hair_back=ImageChops.subtract(hair,hair_front)

    # Inpaint revealed regions. One true DreamShaper inpaint pass for the hair/scalp is the
    # expensive part; small facial repairs use the same model only when explicitly enabled.
    filled=img.copy()
    use_inpaint=os.environ.get("CHARACTER_ENABLE_INPAINT","1")!="0"
    pipe=None
    if use_inpaint:
        try:
            log("loading DreamShaper inpainting model…"); t=time.time(); pipe=inpaint_pipe(); log(f"inpaint ready in {time.time()-t:.1f}s")
        except Exception as e:
            log(f"DreamShaper inpainting unavailable ({str(e)[:160]}) — using CPU pixel fill fallback")
    hair_fill_prompt=str((plan or {}).get("hair_fill_prompt") or "restore the natural scalp and forehead beneath the removed hair, photorealistic skin, consistent lighting and identity, no hat")
    # Only repair the part of the hair footprint that is realistically hiding scalp/forehead.
    # Long side/back hair can cover shoulders or clothing; inpainting that whole region as skin
    # would create an incorrect body when the hair moves.
    shoulder_y_local=int(hb[3]+(hb[3]-hb[1])*.15)
    # Skull-shaped region (ellipse over the head, slightly taller than the face) so
    # voluminous hair cannot turn into an oversized bald head.
    scalp_region=Image.new("L",(W,H),0)
    fw=hb[2]-hb[0]; fh=hb[3]-hb[1]
    ImageDraw.Draw(scalp_region).ellipse([hb[0]-int(fw*.10),hb[1]-int(fh*.38),hb[2]+int(fw*.10),hb[1]+int(fh*.62)],fill=255)
    hair_reveal=ImageChops.multiply(dilate(hair,4),scalp_region)
    if hair_back or hair_front:
        if pipe and hair_reveal.getbbox(): filled=inpaint_region(pipe,filled,hair_reveal,hair_fill_prompt,seed+11)
        elif hair_reveal.getbbox(): filled=cv_inpaint(filled,hair_reveal)
    # Mouth/eye variants are localized and optional. Default: two realistic eye/mouth variants,
    # then map the 9 engine visemes onto them so CPU time remains bounded.
    eye_closed=None; mouth_open=None; mouth_round=None
    eye_masks={}
    for side,key in (("l","l_eye"),("r","r_eye")):
        eye_masks[side]=split_eye_details(m[key], img)
    if pipe and os.environ.get("CHARACTER_GENERATE_VARIANTS","1")!="0":
        try:
            eye_mask=union(dilate(union(m["l_eye"],m["r_eye"]),3))
            eye_closed=inpaint_region(pipe,img,eye_mask,"same character, relaxed closed eyelids, natural eyelid crease, keep the rest of the face unchanged",seed+31,steps=int(os.environ.get("CHARACTER_VARIANT_STEPS","12")))
            mouth_mask=union(dilate(union(m["mouth"],m["u_lip"],m["l_lip"]),3))
            mouth_open=inpaint_region(pipe,img,mouth_mask,"same character, naturally speaking with a moderately open mouth, photorealistic, keep all other facial features unchanged",seed+41,steps=int(os.environ.get("CHARACTER_VARIANT_STEPS","12")))
            mouth_round=inpaint_region(pipe,img,mouth_mask,"same character, rounded O-shaped mouth while speaking, photorealistic, keep all other facial features unchanged",seed+43,steps=int(os.environ.get("CHARACTER_VARIANT_STEPS","12")))
        except Exception as e: log(f"facial variants skipped ({str(e)[:140]})")

    assets={}
    def save(pid,label,mask,source,parent,z,tags):
        if mask is None or not mask.getbbox(): return
        info=extract(source,mask,parts_dir/f"{pid}.png")
        if info: assets[pid]=info; assets[pid]["label"]=label; assets[pid]["parent"]=parent; assets[pid]["z"]=z; assets[pid]["tags"]=tags

    # Base body/head layers use the filled image to cover holes revealed by moving overlays.
    feature=union(hair,m["l_brow"],m["r_brow"],m["l_eye"],m["r_eye"],m["nose"],m["mouth"],m["u_lip"],m["l_lip"])
    head_base=union(m["skin"],m["l_ear"],m["r_ear"],m["neck"])
    if head_base is None: head_base=face_all
    # The repaired scalp footprint is deliberately promoted into the head base.
    # This is the key that makes a lifted/moved wig reveal a believable scalp
    # instead of a transparent hole. Keep long hair lengths out of the skin base.
    head_base=union(head_base,hair_reveal)
    # Subtract only the facial features. Hair is NOT subtracted: the repaired scalp inside the
    # hair footprint must stay in the head layer so moving the hair reveals skin, not a hole.
    face_features=union(m["l_brow"],m["r_brow"],m["l_eye"],m["r_eye"],m["nose"],m["mouth"],m["u_lip"],m["l_lip"])
    head_base=subtract(head_base,face_features)
    neck=m["neck"]
    # Keep the complete human silhouette in the body layer (not just cloth), then
    # remove the head/hair/neck region. This preserves bare legs and arms on
    # dresses, shorts, tank tops and other non-fully-clothed characters.
    head_exclusion=Image.new("L",(W,H),0)
    shoulder_y_local=int(hb[3]+(hb[3]-hb[1])*.15)
    ImageDraw.Draw(head_exclusion).rectangle([max(0,hb[0]-int((hb[2]-hb[0])*.45)),max(0,hb[1]-int((hb[3]-hb[1])*.2)),min(W,hb[2]+int((hb[2]-hb[0])*.45)),min(H,shoulder_y_local)],fill=255)
    body_mask=subtract(alpha,union(head_exclusion,hair,neck))
    # Build conservative limb regions before saving the torso, then remove those pixels
    # from the body so moving a limb cannot leave a duplicate/ghost silhouette behind.
    b=alpha.getbbox() or (0,0,W,H)
    torso_x0=int((b[0]+b[2])/2-W*.20); torso_x1=int((b[0]+b[2])/2+W*.20)
    shoulder_y=int(hb[3]+(hb[3]-hb[1])*.15)
    waist_y=int(b[1]+(b[3]-b[1])*.70)
    side_band_l=Image.new("L",(W,H),0); ImageDraw.Draw(side_band_l).rectangle([0,shoulder_y,torso_x0,waist_y],fill=255)
    side_band_r=Image.new("L",(W,H),0); ImageDraw.Draw(side_band_r).rectangle([torso_x1,shoulder_y,W,waist_y],fill=255)
    arm_l_mask=ImageChops.multiply(alpha,side_band_l); arm_r_mask=ImageChops.multiply(alpha,side_band_r)
    leg_top=max(waist_y,shoulder_y); mid=int((b[0]+b[2])/2)
    leg_l=Image.new("L",(W,H),0); ImageDraw.Draw(leg_l).rectangle([b[0],leg_top,mid,int(b[3])],fill=255)
    leg_r=Image.new("L",(W,H),0); ImageDraw.Draw(leg_r).rectangle([mid,leg_top,b[2],int(b[3])],fill=255)
    leg_l_mask=ImageChops.multiply(alpha,leg_l); leg_r_mask=ImageChops.multiply(alpha,leg_r)
    body_mask=subtract(body_mask,union(arm_l_mask,arm_r_mask,leg_l_mask,leg_r_mask))
    if body_mask is None or not body_mask.getbbox(): body_mask=m["cloth"] if m["cloth"].getbbox() else alpha
    save("body","Body",body_mask,filled,"root",20,["Body","Torso"])
    save("head","Head",head_base,filled,"headGroup",10,["Head","Skin"])
    save("neck","Neck",neck,filled,"root",15,["Neck","Body"])
    save("hair_back","Back Hair",hair_back,img,"root",5,["Hair","BackHair"])
    save("hair_front","Front Hair",hair_front,img,"headGroup",40,["Hair"])
    save("ear_l","Left Ear",m["l_ear"],img,"headGroup",30,["Ear"])
    save("ear_r","Right Ear",m["r_ear"],img,"headGroup",31,["Ear"])
    save("brow_l","Left Eyebrow",m["l_brow"],img,"headGroup",50,["Eyebrow"])
    save("brow_r","Right Eyebrow",m["r_brow"],img,"headGroup",51,["Eyebrow"])
    # Keep the eyeball independent, then split iris/pupil into dedicated movable layers.
    for side in ("l","r"):
        eye_base, iris_mask, pupil_mask = eye_masks.get(side,(m[f"{side}_eye"],None,None))
        save(f"eye_{side}",f"{side.upper()} Eye",subtract(eye_base,union(iris_mask,pupil_mask)),img,"headGroup",55 if side=="l" else 56,["Eyeball"])
        save(f"iris_{side}",f"{side.upper()} Iris",iris_mask,img,"headGroup",57 if side=="l" else 58,["Iris"])
        save(f"pupil_{side}",f"{side.upper()} Pupil",pupil_mask,img,"headGroup",59 if side=="l" else 60,["Pupil"])
    # Closed eyes are separate Blink layers; the engine automatically fades them in during a blink.
    if eye_closed:
        save("blink_l","Left Closed Eye",m["l_eye"],eye_closed,"headGroup",70,["Blink","Eyelid"])
        save("blink_r","Right Closed Eye",m["r_eye"],eye_closed,"headGroup",71,["Blink","Eyelid"])
    save("nose","Nose",m["nose"],img,"headGroup",61,["Nose"])
    # Preserve the actual lips as their own layer. The inner-mouth opening remains separate.
    lip_mask=union(m["u_lip"],m["l_lip"])
    save("lips","Lips",lip_mask,img,"headGroup",65,["Mouth","Lips"])
    save("mouth","Inner Mouth",subtract(m["mouth"],lip_mask),img,"headGroup",66,["Mouth","InnerMouth"])

    # Build viseme files from one speaking mouth + one rounded mouth. This gives all nine engine
    # keys immediately; deployments can set CHARACTER_GENERATE_VISEMES=1 later for nine true edits.
    if mouth_open:
        save("mouth_open","Mouth Open",m["mouth"],mouth_open,"headGroup",66,["Mouth","Viseme"])
    if mouth_round:
        save("mouth_round","Mouth Round",m["mouth"],mouth_round,"headGroup",67,["Mouth","Viseme"])
    save("glasses","Glasses",m["eyeglass"],img,"headGroup",75,["Accessory"])

    save("arm_l","Left Arm",arm_l_mask,img,"root",25,["Arm","LeftArm"])
    save("arm_r","Right Arm",arm_r_mask,img,"root",26,["Arm","RightArm"])
    save("leg_l","Left Leg",leg_l_mask,img,"root",18,["Leg","LeftLeg"])
    save("leg_r","Right Leg",leg_r_mask,img,"root",19,["Leg","RightLeg"])

    # Manifest composition.
    subject_info={"bbox":list(alpha.getbbox() or (0,0,W,H))}
    assets["subject"]=subject_info
    geom=centered_geometry(assets,W,H)
    comp={
      "root":{"id":"root","label":"AI Character","imageUrl":None,"transform":{"x":0,"y":0,"rotation":0,"scaleX":1,"scaleY":1,"anchorX":50,"anchorY":50},"zIndex":0,"tags":[],"parentId":None,"children":[],"isGroup":True,"isIndependent":False,"isVisible":True},
      "headGroup":{"id":"headGroup","label":"Head Group","imageUrl":None,"transform":{"x":geom["headC"]["x"],"y":geom["headC"]["y"],"rotation":0,"scaleX":1,"scaleY":1,"anchorX":50,"anchorY":50},"width":geom["faceW"],"height":geom["faceH"],"zIndex":0,"tags":["Head"],"parentId":"root","children":[],"isGroup":True,"isIndependent":False,"isVisible":True}
    }
    for pid,a in assets.items():
        if pid=="subject": continue
        p=part_def(pid,a.get("label",pid),a, a.get("parent","root"),a.get("z",0),a.get("tags",[]))
        if p: comp[pid]=p; comp[p["parentId"]]["children"].append(pid)
    # Geometry-aware pivots: rotate the head where it joins the neck, not around its centre.
    head_info=assets.get("head"); neck_info=assets.get("neck")
    if head_info and neck_info:
        hx0,hy0,hx1,hy1=head_info["bbox"]; nx0,ny0,nx1,ny1=neck_info["bbox"]
        neck_top=float(ny0); neck_cx=float((nx0+nx1)/2)
        comp["headGroup"]["transform"].update(set_anchor_from_world_bbox({"bbox":[hx0,hy0,hx1,hy1]},neck_cx,neck_top))
        comp["head"]["transform"].update(set_anchor_from_world_bbox(head_info,neck_cx,neck_top))
        comp["neck"]["transform"].update(set_anchor_from_world_bbox(neck_info,neck_cx,float(ny1)))
    # Vision check (optional): refine the neck joint and shoulder pivots.
    vis=vision_refine(img,geom)
    if vis and head_info and neck_info:
        nx,ny=vis["neck_joint"]
        comp["headGroup"]["transform"].update(set_anchor_from_world_bbox({"bbox":head_info["bbox"]},float((neck_info["bbox"][0]+neck_info["bbox"][2])/2),float(neck_info["bbox"][1])))
        comp["neck"]["transform"].update(set_anchor_from_world_bbox(neck_info,float((neck_info["bbox"][0]+neck_info["bbox"][2])/2),max(float(neck_info["bbox"][1]),min(float(neck_info["bbox"][3]),ny))))
        log("vision-refined neck pivot applied")
    # Limb pivots start near their shoulder/hip attachment rather than at the centre.
    for pid,side in (("arm_l","l"),("arm_r","r")):
        if pid in comp:
            info=assets.get(pid); px=(hb[0] if side=="l" else hb[2]); py=shoulder_y
            if vis: px,py=vis["shoulder_left" if side=="l" else "shoulder_right"]
            comp[pid]["transform"].update(set_anchor_from_world_bbox(info,px,py))
    for pid in ("leg_l","leg_r"):
        if pid in comp:
            info=assets.get(pid); px=(b[0]+b[2])*.25 if pid.endswith("l") else (b[0]+b[2])*.75
            comp[pid]["transform"].update(set_anchor_from_world_bbox(info,px,leg_top))

    # CanvasRenderEngine uses child traversal order for painting. Make the order explicit so
    # back hair/body/legs render behind the face while facial overlays remain on top.
    order=["hair_back","leg_l","leg_r","body","neck","arm_l","arm_r","headGroup"]
    comp["root"]["children"]=[pid for pid in order if pid in comp]
    head_order=["head","ear_l","ear_r","hair_front","brow_l","brow_r","eye_l","eye_r","iris_l","iris_r","pupil_l","pupil_r","blink_l","blink_r","nose","lips","mouth","mouth_open","mouth_round","glasses"]
    comp["headGroup"]["children"]=[pid for pid in head_order if pid in comp]
    # A deterministic name gives saved characters a stable human-readable label.
    name=str((plan or {}).get("name") or ("Generated Presenter" if mode=="generate" else "Imported Character"))[:80]
    # 9 viseme keys expected by the existing lip-sync engine.
    def f(pid):
        return f"parts/{pid}.png" if pid in assets else ("parts/mouth.png" if "mouth" in assets else None)
    rest=f("mouth"); op=f("mouth_open") or rest; rnd=f("mouth_round") or op or rest
    v={"REST":rest,"AI":op,"E":op,"O":rnd,"MBP":rest,"L":op,"CONS":rest,"U":op,"FV":op}
    manifest={
      "version":1,"kind":"ai-rig","name":name,"gender":gender,"fullBody":bool(full_body),"sourceMode":mode,
      "sourcePrompt":str((plan or {}).get("prompt") or "")[:1200],"canvas":{"width":W,"height":H},"geometry":geom,
      "characters":[{"id":"presenter","name":name,"composition":comp}],"visemeMap":v,
      "mouthSets":{"neutral":v,"smile":v,"happy":v,"sad":v},
      "eyes":{"happy":[],"open":[x for x in ["eye_l","eye_r"] if x in comp]},"extras":{"tears":[],"glow":""},"arms":[],
      "camera":{"x":0,"y":0,"scale":1,"rotation":0},"filters":{},"lights":[],"ambient":1,"aspect":{"w":9,"h":16},
      "notes":{"faceParser":"BiSeNet/CelebAMask-HQ 19-class","inpaint":"DreamShaper inpainting for revealed areas","visemes":"9 engine keys mapped to localized mouth variants"}
    }
    json.dump(manifest,open(out/"manifest.json","w",encoding="utf8"),indent=2)
    # Preview shows the repaired image so the user sees the actual source that the rig was built from.
    preview=filled.copy(); preview.putalpha(alpha)
    if max(preview.size)>768:
        ratio=768.0/max(preview.size); preview=preview.resize((max(1,int(preview.width*ratio)),max(1,int(preview.height*ratio))),Image.Resampling.LANCZOS)
    preview.save(out/"preview.png","PNG",optimize=True,compress_level=9)
    return manifest


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--input",required=True); ap.add_argument("--output",required=True); ap.add_argument("--mode",choices=["generate","upload"],default="upload"); ap.add_argument("--gender",default="female"); ap.add_argument("--full-body",action="store_true"); ap.add_argument("--seed",type=int,default=1); ap.add_argument("--plan",default="{}"); args=ap.parse_args()
    try:
        plan=json.loads(args.plan) if args.plan else {}
        build(args.input,args.output,args.mode,plan,args.gender,args.full_body,args.seed)
        return 0
    except Exception as e:
        traceback.print_exc(); return 1

if __name__=="__main__": sys.exit(main())
