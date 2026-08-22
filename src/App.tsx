import React, { useState, useEffect, useRef, useCallback } from 'react';
import gameData from './game-data.json';

// --- Shared Audio Engine ---
let globalAudioCtx: AudioContext | null = null;
const decodedBufferCache: Record<string, AudioBuffer> = {};
const activeAudioSources: AudioBufferSourceNode[] = [];
let masterSoundVolume = 1;

const normalizeDataURL = (dataURL: string): string => {
  if (!dataURL || !dataURL.startsWith('data:')) return dataURL;
  let [header, dataPart] = dataURL.split(',');
  if (!dataPart) return dataURL;
  const mimeMatch = header.match(/data:(.*?)(;|$)/);
  if (mimeMatch) {
    const mime = mimeMatch[1];
    if (mime === 'audio/mp3' || mime === 'audio/x-mp3' || mime === 'audio/x-mpeg') {
      header = header.replace(mime, 'audio/mpeg');
    } else if (mime === 'audio/x-wav') {
      header = header.replace(mime, 'audio/wav');
    } else if (mime === 'audio/x-m4a' || mime === 'audio/m4a') {
      header = header.replace(mime, 'audio/mp4');
    }
  }
  return `${header},${dataPart}`;
};

const dataURLToArrayBuffer = (dataURL: string): ArrayBuffer => {
  try {
    const normalized = normalizeDataURL(dataURL);
    const parts = normalized.split(',');
    if (parts.length < 2) return new ArrayBuffer(0);
    const header = parts[0];
    const dataPart = parts[1];
    const binaryString = header.includes(';base64') ? atob(decodeURIComponent(dataPart)) : decodeURIComponent(dataPart);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  } catch (err) {
    console.warn("ArrayBuffer conversion error:", err);
    return new ArrayBuffer(0);
  }
};

const getSharedAudioContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;
  if (!globalAudioCtx) {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      globalAudioCtx = new AudioCtx();
    }
  }
  if (globalAudioCtx && globalAudioCtx.state === 'suspended') {
    globalAudioCtx.resume().catch(() => {});
  }
  return globalAudioCtx;
};

if (typeof window !== 'undefined') {
  const unlock = () => {
    try {
      const ctx = getSharedAudioContext();
      if (ctx && ctx.state === 'running') {
        window.removeEventListener('click', unlock);
        window.removeEventListener('keydown', unlock);
        window.removeEventListener('touchstart', unlock);
        window.removeEventListener('pointerdown', unlock);
      }
    } catch (e) {}
  };
  window.addEventListener('click', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
  window.addEventListener('touchstart', unlock, { passive: true });
  window.addEventListener('pointerdown', unlock, { passive: true });
}

function clampCameraToBounds(
  camX: number,
  camY: number,
  zoom: number,
  elements: any[],
  vWidth: number = 640,
  vHeight: number = 360
): { x: number; y: number } {
  const bgEl = (elements || []).find(el => el && el.type === 'bg' && !el.hidden);
  if (!bgEl) {
    // When there is NO environment, camera panning is completely unconstrained
    return { x: camX, y: camY };
  }
  const bgX = Number(bgEl.x || 0);
  const bgY = Number(bgEl.y || 0);
  const bgScale = Number(bgEl.scale || 1);
  const bgW = Number(bgEl.width || vWidth) * bgScale;
  const bgH = Number(bgEl.height || vHeight) * bgScale;

  const currentZoom = Math.max(0.1, zoom || 1);
  const halfViewW = (vWidth / 2) / currentZoom;
  const halfViewH = (vHeight / 2) / currentZoom;

  const minWorldX = bgX + halfViewW;
  const maxWorldX = bgX + bgW - halfViewW;
  const minWorldY = bgY + halfViewH;
  const maxWorldY = bgY + bgH - halfViewH;

  let worldCenterX = vWidth / 2 - camX;
  let worldCenterY = vHeight / 2 - camY;

  if (minWorldX >= maxWorldX) {
    worldCenterX = bgX + bgW / 2;
  } else {
    worldCenterX = Math.max(minWorldX, Math.min(maxWorldX, worldCenterX));
  }

  if (minWorldY >= maxWorldY) {
    worldCenterY = bgY + bgH / 2;
  } else {
    worldCenterY = Math.max(minWorldY, Math.min(maxWorldY, worldCenterY));
  }

  return {
    x: vWidth / 2 - worldCenterX,
    y: vHeight / 2 - worldCenterY
  };
}

function computeElementZIndex(el: any, layers: any[] = [], opts: any = {}): number {
  if (!el) return 0;
  if (el.type === 'bg') return 0;
  const layerList = Array.isArray(layers) ? layers : [];
  const layerIdx = layerList.findIndex((l: any) => l && l.id === el.layerId);
  const fallbackIdx = Math.max(0, layerList.length - 1);
  const effectiveIdx = layerIdx === -1 ? fallbackIdx : layerIdx;
  const layerZ = (layerList.length - effectiveIdx) * 1000000;
  const elementZOffset = Number(el.zIndex) || 0;
  const baseZ = layerZ + elementZOffset;
  const isButton = el.type === 'btn';
  const isText = el.type === 'text' || opts.gameObject?.type === 'text' || opts.gameObject?.type === 'var_text';
  const isVideo = el.type === 'video';
  let categoryBonus = 0;
  if (isButton) {
    categoryBonus = 50000;
  } else if (isText) {
    categoryBonus = 40000;
  } else if (isVideo) {
    categoryBonus = 30000;
  }
  return baseZ + categoryBonus;
}

const playBeepWithSharedContext = () => {
  try {
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    osc.frequency.value = 523.25;
    gainNode.gain.setValueAtTime(0.1 * masterSoundVolume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01 * masterSoundVolume, ctx.currentTime + 0.3);
    osc.start(0);
    osc.stop(ctx.currentTime + 0.3);
  } catch (err) {
    console.warn("Beep failed:", err);
  }
};

const playSoundWithSharedContext = async (audioSrc: string) => {
  if (!audioSrc) return;
  try {
    const ctx = getSharedAudioContext();
    if (!ctx) {
      const audio = new Audio(audioSrc);
      audio.volume = Math.max(0, Math.min(1, masterSoundVolume));
      audio.play().catch(() => {});
      return;
    }

    const startBuffer = (audioBuffer: AudioBuffer) => {
      const source = ctx.createBufferSource();
      const gainNode = ctx.createGain();
      gainNode.gain.value = Math.max(0, Math.min(1, masterSoundVolume));
      source.buffer = audioBuffer;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);
      source.start(0);
      activeAudioSources.push(source);
      source.onended = () => {
        const idx = activeAudioSources.indexOf(source);
        if (idx !== -1) activeAudioSources.splice(idx, 1);
      };
    };

    if (decodedBufferCache[audioSrc]) {
      startBuffer(decodedBufferCache[audioSrc]);
      return;
    }

    let arrayBuffer: ArrayBuffer;
    if (audioSrc.startsWith('data:')) {
      arrayBuffer = dataURLToArrayBuffer(audioSrc);
    } else {
      const response = await fetch(audioSrc);
      arrayBuffer = await response.arrayBuffer();
    }

    if (arrayBuffer && arrayBuffer.byteLength > 0) {
      ctx.decodeAudioData(
        arrayBuffer,
        (audioBuffer) => {
          decodedBufferCache[audioSrc] = audioBuffer;
          startBuffer(audioBuffer);
        },
        () => {
          try {
            const audio = new Audio(audioSrc);
            audio.volume = Math.max(0, Math.min(1, masterSoundVolume));
            audio.play().catch(() => playBeepWithSharedContext());
          } catch (e) {
            playBeepWithSharedContext();
          }
        }
      );
    } else {
      playBeepWithSharedContext();
    }
  } catch (err) {
    try {
      const audio = new Audio(audioSrc);
      audio.volume = Math.max(0, Math.min(1, masterSoundVolume));
      audio.play().catch(() => playBeepWithSharedContext());
    } catch (e) {
      playBeepWithSharedContext();
    }
  }
};

const stopAllActiveSounds = () => {
  activeAudioSources.forEach(s => {
    try { s.stop(0); } catch (e) {}
  });
  activeAudioSources.length = 0;
};

// Safe Autoplay Video Execution with Gesture Unlock Fallback
const playVideoElementSafely = (videoEl: HTMLVideoElement, opts: { loop?: boolean; muted?: boolean; volume?: number; speed?: number } = {}) => {
  if (!videoEl) return;
  if (opts.loop !== undefined) videoEl.loop = opts.loop;
  if (opts.volume !== undefined) videoEl.volume = Math.max(0, Math.min(1, opts.volume));
  if (opts.speed !== undefined) videoEl.playbackRate = Math.max(0.25, Math.min(4, opts.speed));
  if (opts.muted !== undefined) videoEl.muted = opts.muted;

  const playPromise = videoEl.play();
  if (playPromise !== undefined) {
    playPromise.catch((err) => {
      console.warn('[VideoPlayback] Autoplay restricted. Fallback to muted playback:', err);
      videoEl.muted = true;
      videoEl.play().catch((e) => console.error('[VideoPlayback] Muted autoplay also failed:', e));

      const unlockAudio = () => {
        if (!opts.muted) {
          videoEl.muted = false;
        }
        window.removeEventListener('click', unlockAudio);
        window.removeEventListener('touchstart', unlockAudio);
        window.removeEventListener('keydown', unlockAudio);
        window.removeEventListener('pointerdown', unlockAudio);
      };
      window.addEventListener('click', unlockAudio, { once: true });
      window.addEventListener('touchstart', unlockAudio, { once: true });
      window.addEventListener('keydown', unlockAudio, { once: true });
      window.addEventListener('pointerdown', unlockAudio, { once: true });
    });
  }
};

// --- Sprite Animation Component ---
const AnimatedSprite = ({ frames, fps = 24, speed = 1, tintColor, width, height }: { frames: string[]; fps?: number; speed?: number; tintColor?: string; width?: number; height?: number }) => {
  const [currentFrame, setCurrentFrame] = useState(0);

  useEffect(() => {
    if (!frames || frames.length === 0) return;
    const actualFps = Math.max(1, (fps || 24) * (speed || 1));
    const interval = setInterval(() => {
      setCurrentFrame((prev) => (prev + 1) % frames.length);
    }, 1000 / actualFps);
    return () => clearInterval(interval);
  }, [frames, fps, speed]);

  if (!frames || frames.length === 0) {
    return <div className="w-full h-full bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-[10px] text-cyan-400">No Frames</div>;
  }

  return (
    <div className="relative w-full h-full select-none pointer-events-none">
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundImage: `url(${frames[currentFrame] || frames[0]})`,
          backgroundSize: '100% 100%',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center'
        }}
      />
      {tintColor && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundColor: tintColor,
            maskImage: `url(${frames[currentFrame] || frames[0]})`,
            WebkitMaskImage: `url(${frames[currentFrame] || frames[0]})`,
            maskSize: '100% 100%',
            WebkitMaskSize: '100% 100%',
            maskRepeat: 'no-repeat',
            WebkitMaskRepeat: 'no-repeat',
            mixBlendMode: 'color'
          }}
        />
      )}
    </div>
  );
};

// --- Unified Event Condition Evaluation Engine ---
const TRIGGER_CONDITION_TYPES = [
  'scene_start',
  'pressed',
  'pressed_time',
  'double_tap',
  'click',
  'key_pressed',
  'key_down',
  'key_held',
  'key_up',
  'screen_touched',
  'screen_swiped',
  'video_ended',
  'always'
];

const normalizeSwipeDirection = (raw: any): 'up' | 'down' | 'left' | 'right' | 'any' => {
  if (!raw) return 'any';
  const str = String(raw).toLowerCase().trim();
  if (!str || str === 'any' || str === 'all' || str === '*' || str === 'none') return 'any';
  if (str.includes('left') || str === 'l' || str.includes('⬅') || str.includes('arrowleft')) return 'left';
  if (str.includes('right') || str === 'r' || str.includes('➡') || str.includes('arrowright')) return 'right';
  if (str.includes('up') || str === 'u' || str.includes('⬆') || str.includes('arrowup') || str.includes('top')) return 'up';
  if (str.includes('down') || str === 'd' || str.includes('⬇') || str.includes('arrowdown') || str.includes('bottom')) return 'down';
  return 'any';
};

const checkKeyMatch = (target: string, keyName: string, keyCode?: string): boolean => {
  const t = String(target || '').toLowerCase().trim();
  const k = String(keyName || '').toLowerCase().trim();
  const c = String(keyCode || '').toLowerCase().trim();
  if (!t) return false;
  if (t === k || (c && t === c)) return true;
  if (t === 'left' || t === 'arrowleft') return k === 'arrowleft' || k === 'a' || c === 'arrowleft' || c === 'keya';
  if (t === 'right' || t === 'arrowright') return k === 'arrowright' || k === 'd' || c === 'arrowright' || c === 'keyd';
  if (t === 'up' || t === 'arrowup') return k === 'arrowup' || k === 'w' || c === 'arrowup' || c === 'keyw';
  if (t === 'down' || t === 'arrowdown') return k === 'arrowdown' || k === 's' || c === 'arrowdown' || c === 'keys';
  if (t === 'space' || t === ' ') return k === ' ' || k === 'space' || c === 'space';
  if (t === 'shift') return k === 'shift' || c === 'shiftleft' || c === 'shiftright';
  if (t === 'ctrl' || t === 'control') return k === 'control' || c === 'controlleft' || c === 'controlright';
  if (t === 'alt') return k === 'alt' || c === 'altleft' || c === 'altright';
  if (t === 'enter') return k === 'enter' || c === 'enter' || c === 'numpadenter';
  return false;
};

const isKeyCurrentlyHeld = (target: string, activeKeys: Set<string>): boolean => {
  const t = String(target || '').toLowerCase().trim();
  if (!t) return false;
  if (activeKeys.has(t)) return true;
  if (t === 'left' || t === 'arrowleft') return activeKeys.has('arrowleft') || activeKeys.has('a') || activeKeys.has('keya');
  if (t === 'right' || t === 'arrowright') return activeKeys.has('arrowright') || activeKeys.has('d') || activeKeys.has('keyd');
  if (t === 'up' || t === 'arrowup') return activeKeys.has('arrowup') || activeKeys.has('w') || activeKeys.has('keyw');
  if (t === 'down' || t === 'arrowdown') return activeKeys.has('arrowdown') || activeKeys.has('s') || activeKeys.has('keys');
  if (t === 'space' || t === ' ') return activeKeys.has(' ') || activeKeys.has('space');
  if (t === 'shift') return activeKeys.has('shift') || activeKeys.has('shiftleft') || activeKeys.has('shiftright');
  if (t === 'ctrl' || t === 'control') return activeKeys.has('control') || activeKeys.has('controlleft') || activeKeys.has('controlright');
  if (t === 'alt') return activeKeys.has('alt') || activeKeys.has('altleft') || activeKeys.has('altright');
  if (t === 'enter') return activeKeys.has('enter') || activeKeys.has('numpadenter');
  return false;
};

const evaluateEventConditions = (
  ev: any,
  triggerContext: {
    type: 'pointer_up' | 'key_down' | 'key_up' | 'key_held_tick' | 'click' | 'video_ended' | 'scene_start' | 'tick';
    key?: string;
    code?: string;
    swipeDir?: string;
    isTap?: boolean;
    isDoubleTap?: boolean;
    targetId?: string;
    targetData?: string;
    targetBtnId?: string;
    videoId?: string;
    elementId?: string;
  },
  evKey: string,
  ctx: {
    activeKeysDown: Set<string>;
    evaluateSingleCondition: (cond: any, evKey: string) => boolean;
  }
): boolean => {
  if (!ev) return false;
  if (!ev.conditions || ev.conditions.length === 0) return true;

  // Gate primary triggers
  if (triggerContext.type === 'scene_start') {
    const hasSceneStart = ev.conditions.some((c: any) => c.type === 'scene_start');
    if (!hasSceneStart) return false;
  } else if (triggerContext.type === 'pointer_up') {
    if (triggerContext.swipeDir) {
      const hasSwipe = ev.conditions.some((c: any) => c.type === 'screen_swiped');
      if (!hasSwipe) return false;
    } else if (triggerContext.isTap) {
      const hasTouch = ev.conditions.some((c: any) => c.type === 'screen_touched');
      if (!hasTouch) return false;
    }
  } else if (triggerContext.type === 'click') {
    const hasClick = ev.conditions.some((c: any) =>
      ['pressed', 'pressed_time', 'double_tap', 'click', 'screen_touched'].includes(c.type)
    );
    if (!hasClick) return false;
  } else if (triggerContext.type === 'key_down') {
    const hasKey = ev.conditions.some((c: any) =>
      ['key_pressed', 'key_down', 'key_held'].includes(c.type)
    );
    if (!hasKey) return false;
  } else if (triggerContext.type === 'key_up') {
    const hasKeyUp = ev.conditions.some((c: any) => c.type === 'key_up');
    if (!hasKeyUp) return false;
  } else if (triggerContext.type === 'key_held_tick') {
    const hasKeyHeld = ev.conditions.some((c: any) =>
      ['key_down', 'key_held'].includes(c.type)
    );
    if (!hasKeyHeld) return false;
  } else if (triggerContext.type === 'video_ended') {
    const hasVideoEnded = ev.conditions.some((c: any) => c.type === 'video_ended');
    if (!hasVideoEnded) return false;
  } else if (triggerContext.type === 'tick') {
    const hasInstant = ev.conditions.some((c: any) =>
      ['scene_start', 'pressed', 'pressed_time', 'double_tap', 'click', 'key_pressed', 'key_up', 'screen_touched', 'screen_swiped', 'video_ended', 'key_down', 'key_held'].includes(c.type)
    );
    if (hasInstant) return false;
  }

  // Strict AND logic across all conditions
  for (const cond of ev.conditions) {
    if (TRIGGER_CONDITION_TYPES.includes(cond.type as any)) {
      if (cond.type === 'scene_start') {
        if (triggerContext.type !== 'scene_start') return false;
      } else if (cond.type === 'screen_swiped') {
        if (triggerContext.type !== 'pointer_up' || !triggerContext.swipeDir) return false;
        const expectedDir = normalizeSwipeDirection(cond.direction || cond.value || cond.swipeDirection || cond.swipeDir || cond.target);
        const actualDir = normalizeSwipeDirection(triggerContext.swipeDir);
        if (expectedDir !== 'any' && expectedDir !== actualDir) return false;
      } else if (cond.type === 'screen_touched') {
        if (triggerContext.type === 'pointer_up') {
          if (!triggerContext.isTap || triggerContext.isDoubleTap) return false;
        } else if (triggerContext.type !== 'click') return false;
        const rawTarget = String(cond.target || '').trim();
        const isTargetObject = rawTarget && rawTarget !== 'any' && rawTarget !== 'screen';
        if (isTargetObject && (triggerContext.targetId || triggerContext.targetData || triggerContext.targetBtnId)) {
          const tId = String(triggerContext.targetId || '').trim();
          const tData = String(triggerContext.targetData || '').trim();
          const tBtnId = String(triggerContext.targetBtnId || '').trim();
          if (rawTarget !== tId && rawTarget !== tData && rawTarget !== tBtnId) return false;
        }
      } else if (cond.type === 'double_tap') {
        if (triggerContext.type !== 'pointer_up' || !triggerContext.isDoubleTap) return false;
      } else if (cond.type === 'pressed' || cond.type === 'pressed_time' || cond.type === 'click') {
        if (triggerContext.type !== 'click' && triggerContext.type !== 'pointer_up') return false;
        if (triggerContext.type === 'pointer_up' && !triggerContext.isTap) return false;
        const target = String(cond.target || '').trim();
        if (target && target !== 'any') {
          const tId = String(triggerContext.targetId || '').trim();
          const tData = String(triggerContext.targetData || '').trim();
          const tBtnId = String(triggerContext.targetBtnId || '').trim();
          if (target !== tId && target !== tData && target !== tBtnId) return false;
        }
      } else if (cond.type === 'key_pressed' || cond.type === 'key_down' || cond.type === 'key_held') {
        const targetKey = String(cond.target || cond.value || '').toLowerCase().trim();
        if (triggerContext.type === 'key_held_tick') {
          if (!isKeyCurrentlyHeld(targetKey, ctx.activeKeysDown)) return false;
        } else if (triggerContext.type === 'key_down') {
          if (!checkKeyMatch(targetKey, triggerContext.key || '', triggerContext.code) && !isKeyCurrentlyHeld(targetKey, ctx.activeKeysDown)) return false;
        } else {
           if (!isKeyCurrentlyHeld(targetKey, ctx.activeKeysDown)) return false;
        }
      } else if (cond.type === 'key_up') {
        if (triggerContext.type !== 'key_up') return false;
        const targetKey = String(cond.target || cond.value || '').toLowerCase().trim();
        if (!checkKeyMatch(targetKey, triggerContext.key || '', triggerContext.code)) return false;
      } else if (cond.type === 'video_ended') {
        if (triggerContext.type !== 'video_ended') return false;
      } else if (cond.type === 'always') {
        return true;
      }
    } else {
      if (!ctx.evaluateSingleCondition(cond, evKey)) return false;
    }
  }
  return true;
};

// --- Main Active Game Content ---
function ActiveGame() {
  const [activeSceneId, setActiveSceneId] = useState<string>(
    gameData.activeSceneId || gameData.scenes?.[0]?.id || 'scene_1'
  );
  const [variables, setVariables] = useState<any[]>(() => 
    JSON.parse(JSON.stringify(gameData.variables || []))
  );
  const [timers, setTimers] = useState<any[]>(() =>
    (gameData.timers || []).map((t: any) => ({ ...t, time: 0, state: t.state || 'stopped' }))
  );
  const [stageElements, setStageElements] = useState<any[]>([]);
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 640,
    height: typeof window !== 'undefined' ? window.innerHeight : 360
  });

  useEffect(() => {
    // Attempt to force fullscreen
    const requestFullScreen = () => {
      const docElm = document.documentElement as any;
      if (docElm.requestFullscreen) docElm.requestFullscreen();
      else if (docElm.mozRequestFullScreen) docElm.mozRequestFullScreen();
      else if (docElm.webkitRequestFullScreen) docElm.webkitRequestFullScreen();
      else if (docElm.msRequestFullscreen) docElm.msRequestFullscreen();
    };

    // Browsers often require a user gesture to enter fullscreen, so we attach it to the first touch/click
    const onUserInteraction = () => {
      requestFullScreen();
      document.removeEventListener('touchstart', onUserInteraction);
      document.removeEventListener('click', onUserInteraction);
    };
    document.addEventListener('touchstart', onUserInteraction);
    document.addEventListener('click', onUserInteraction);

    // Push state for back button exit
    window.history.pushState({ game: 'active' }, '');
    const handlePopState = () => {
      // If user presses back, they exit fullscreen, or we can close the game
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    };
    window.addEventListener('popstate', handlePopState);
    
    return () => {
      document.removeEventListener('touchstart', onUserInteraction);
      document.removeEventListener('click', onUserInteraction);
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const [showRotationPrompt, setShowRotationPrompt] = useState(false);

  // Visual Effects State
  const [cameraShake, setCameraShake] = useState<{ 
    active: boolean; 
    intensity: number; 
    expiresAt: number;
    zoom: number;
    panX: number;
    panY: number;
  }>({
    active: false,
    intensity: 0,
    expiresAt: 0,
    zoom: 1,
    panX: 0,
    panY: 0
  });
  const [shakeOffset, setShakeOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [globalCamera, setGlobalCamera] = useState({ zoom: 1, x: 0, y: 0 });
  const [cameraFollowTarget, setCameraFollowTarget] = useState<string | null>(gameData.cameraFollowTarget || null);
  const [isCameraFollowEnabled, setIsCameraFollowEnabled] = useState(gameData.isCameraFollowEnabled !== undefined ? gameData.isCameraFollowEnabled : true);
  const cameraFollowTargetRef = useRef<string | null>(null);
  useEffect(() => { cameraFollowTargetRef.current = isCameraFollowEnabled ? cameraFollowTarget : null; }, [cameraFollowTarget, isCameraFollowEnabled]);
  const [attachments, setAttachments] = useState<any[]>(gameData.attachments || []);
  const [joystickStates, setJoystickStates] = useState<Record<string, { active: boolean, x: number, y: number, angle: number, normX: number, normY: number, distance: number }>>({});
  const joystickStatesRef = useRef<Record<string, any>>({});
  joystickStatesRef.current = joystickStates;
  const [screenFlash, setScreenFlash] = useState<{ active: boolean; color: string; duration: number; startedAt: number }>({
    active: false,
    color: '#ffffff',
    duration: 0.3,
    startedAt: 0
  });
  const [floatingTexts, setFloatingTexts] = useState<any[]>([]);
  const activeKeysDown = useRef<Set<string>>(new Set());
  const touchStartPosRef = useRef<{ x: number; y: number; time: number; targetId?: string; targetData?: string; targetBtnId?: string } | null>(null);
  const isSwipingActiveRef = useRef<boolean>(false);
  const lastTapRef = useRef<{ time: number, x: number, y: number, targetId?: string } | null>(null);
  const tapTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const timerValuesRef = useRef<Record<string, number>>({ scene_timer: 0 });
  const periodicTimersRef = useRef<Record<string, number>>({});

  const stageElementsRef = useRef(stageElements);
  stageElementsRef.current = stageElements;

  const variablesRef = useRef(variables);
  variablesRef.current = variables;
  const globalCameraRef = useRef(globalCamera);
  globalCameraRef.current = globalCamera;

  const timersRef = useRef(timers);
  timersRef.current = timers;

  const activeSceneIdRef = useRef(activeSceneId);
  activeSceneIdRef.current = activeSceneId;

  const aspectRatio = gameData.aspectRatio || 'landscape';
  const VIRTUAL_WIDTH = aspectRatio === 'landscape' ? 640 : 360;
  const VIRTUAL_HEIGHT = aspectRatio === 'landscape' ? 360 : 640;

  // Responsive scale & Orientation check
  useEffect(() => {
    const handleResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setWindowSize({ width: w, height: h });
      if (aspectRatio === 'landscape' && w < h) {
        setShowRotationPrompt(true);
      } else if (aspectRatio === 'portrait' && w > h) {
        setShowRotationPrompt(true);
      } else {
        setShowRotationPrompt(false);
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [aspectRatio]);

  // Scale is handled via a CSS variable set by the wrapper rect
  // const scale = Math.min(windowSize.width / VIRTUAL_WIDTH, windowSize.height / VIRTUAL_HEIGHT);

  // Camera Shake Interval
  useEffect(() => {
    if (!cameraShake.active) {
      setShakeOffset({ x: 0, y: 0 });
      return;
    }
    const interval = setInterval(() => {
      if (Date.now() > cameraShake.expiresAt) {
        setCameraShake({ active: false, intensity: 0, expiresAt: 0, zoom: 1, panX: 0, panY: 0 });
        setShakeOffset({ x: 0, y: 0 });
      } else {
        const factor = cameraShake.intensity;
        setShakeOffset({
          x: (Math.random() - 0.5) * factor * 2,
          y: (Math.random() - 0.5) * factor * 2
        });
      }
    }, 16);
    return () => clearInterval(interval);
  }, [cameraShake]);

  // Load scene elements when active scene changes
  useEffect(() => {
    const rawSceneEls = (gameData.sceneElements && (gameData.sceneElements as any)[activeSceneId]) || [];
    setStageElements(JSON.parse(JSON.stringify(rawSceneEls)));
  }, [activeSceneId]);

  // Auto-play videos present in scene elements on load
  useEffect(() => {
    stageElements.forEach(el => {
      if (el.type === 'video') {
        setTimeout(() => {
          const elVid = document.getElementById(`video_player_${el.id}`) as HTMLVideoElement;
          if (elVid) {
            playVideoElementSafely(elVid, { loop: el.loop ?? false, muted: el.muted ?? false });
          }
        }, 80);
      }
    });
  }, [stageElements.length]);

  // Helper to resolve video source
  const resolveVideoUrl = (videoIdOrUrl: string) => {
    if (!videoIdOrUrl) return '';
    const found = (gameData.projectVideos || []).find(
      (v: any) => String(v.id) === String(videoIdOrUrl) || v.name === videoIdOrUrl || v.url === videoIdOrUrl
    );
    return found?.url || videoIdOrUrl;
  };

  // Video Ended Event Trigger
  const handleVideoEnded = (videoId: string, elementId: string) => {
    const sceneEvents = (gameData.sceneEvents && (gameData.sceneEvents as any)[activeSceneId]) || [];
    sceneEvents.forEach((ev: any) => {
      if (evaluateEventConditions(ev, {
        type: 'video_ended',
        videoId,
        elementId
      }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
        ev.actions?.forEach((act: any) => executeAction(act));
      }
    });
  };

  // Action Dispatcher
  const executeAction = (act: any) => {
    if (!act || !act.type) return;

    const doAction = () => {
      switch (act.type) {
        case 'goto_scene': {
          if (act.target) {
            const exists = (gameData.scenes || []).some((s: any) => s.id === act.target);
            if (exists) {
              setActiveSceneId(act.target);
            }
          }
          break;
        }

        case 'restart_scene': {
          const currentId = activeSceneIdRef.current;
          const rawSceneEls = (gameData.sceneElements && (gameData.sceneElements as any)[currentId]) || [];
          setStageElements(JSON.parse(JSON.stringify(rawSceneEls)));
          break;
        }

        case 'set_var': {
          if (act.target) {
            const targetVar = variablesRef.current.find(v => v.id === act.target || v.name === act.target);
            let val = act.value;
            if (targetVar) {
              if (targetVar.type === 'number') {
                val = Number(act.value ?? 0);
                if (act.operator && act.operator !== '=') {
                  const currentVal = Number(targetVar.value ?? 0);
                  if (act.operator === '+=') val = currentVal + val;
                  else if (act.operator === '-=') val = currentVal - val;
                  else if (act.operator === '*=') val = currentVal * val;
                  else if (act.operator === '/=') val = val !== 0 ? currentVal / val : currentVal;
                }
              } else if (targetVar.type === 'boolean') {
                val = String(act.value) === 'true';
              } else {
                val = String(act.value ?? '');
              }
            }
            setVariables(prev => prev.map(v => (v.id === act.target || v.name === act.target) ? { ...v, value: val } : v));
          }
          break;
        }

        case 'random_number': {
          if (act.target) {
            const min = Number(act.min ?? act.value ?? 0);
            const max = Number(act.max ?? 100);
            const randVal = Math.floor(Math.random() * (max - min + 1)) + min;
            setVariables(prev => prev.map(v => (v.id === act.target || v.name === act.target) ? { ...v, value: randVal } : v));
          }
          break;
        }

        case 'toggle_var': {
          if (act.target) {
            setVariables(prev => prev.map(v => {
              if (v.id === act.target || v.name === act.target) {
                return { ...v, value: !v.value };
              }
              return v;
            }));
          }
          break;
        }

        case 'camera_follow':
        if (act.target) {
          setCameraFollowTarget(act.target);
          setIsCameraFollowEnabled(true);
        }
        break;
      case 'camera_unfollow':
        setIsCameraFollowEnabled(false);
        break;
      case 'spawn_randomly_around_character':
        if (act.target && act.value) {
          const char = stageElementsRef.current.find(el => el.id === act.target || el.data === act.target);
          if (char) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 100 + Math.random() * 200;
            const spawnX = (char.x || 0) + (char.width || 50)/2 + Math.cos(angle) * dist;
            const spawnY = (char.y || 0) + (char.height || 50)/2 + Math.sin(angle) * dist;
            const newId = `spawned_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            setStageElements(prev => [...prev, { id: newId, type: 'obj', data: act.value, x: spawnX, y: spawnY, width: 100, height: 100, zIndex: 10 }]);
          }
        }
        break;
      case 'spawn_randomly_on_map':
        if (act.value) {
           const spawnX = Math.random() * VIRTUAL_WIDTH;
           const spawnY = Math.random() * VIRTUAL_HEIGHT;
           const newId = `spawned_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
           setStageElements(prev => [...prev, { id: newId, type: 'obj', data: act.value, x: spawnX, y: spawnY, width: 100, height: 100, zIndex: 10 }]);
        }
        break;
      case 'start_timer':
        case 'play_timer': {
          if (act.target) {
            setTimers((prev) =>
              prev.map((t) => (t.id === act.target || t.name === act.target ? { ...t, state: 'playing', time: act.type === 'start_timer' ? 0 : t.time } : t))
            );
          }
          break;
        }

        case 'pause_timer': {
          if (act.target) {
            setTimers((prev) =>
              prev.map((t) => (t.id === act.target || t.name === act.target ? { ...t, state: 'paused' } : t))
            );
          }
          break;
        }

        case 'stop_timer': {
          if (act.target) {
            setTimers((prev) =>
              prev.map((t) => (t.id === act.target || t.name === act.target ? { ...t, state: 'stopped', time: 0 } : t))
            );
          }
          break;
        }

        case 'change_opacity': {
          if (act.target) {
            const val = Number(act.value ?? 100) / 100;
            setStageElements((prev) =>
              prev.map((el) =>
                el.id === act.target || el.data === act.target || el.buttonId === act.target
                  ? { ...el, opacity: val }
                  : el
              )
            );
          }
          break;
        }

        case 'destroy': {
          if (act.target) {
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                return { ...el, isDestroying: true, destroyEffect: act.effect || 'vanish' };
              }
              return el;
            }));
            setTimeout(() => {
              setStageElements(prev => prev.filter(el => el.data !== act.target && el.id !== act.target && el.buttonId !== act.target));
            }, 1000);
          } else {
            setStageElements(prev => prev.map(el => {
              if (el.type === 'obj' || el.type === 'btn') {
                return { ...el, isDestroying: true, destroyEffect: act.effect || 'vanish' };
              }
              return el;
            }));
            setTimeout(() => {
              setStageElements(prev => prev.filter(el => el.type !== 'obj' && el.type !== 'btn'));
            }, 1000);
          }
          break;
        }

        case 'play_sound': {
          try {
            if (act.value) {
              const sound = (gameData.projectSounds || []).find((s: any) => s.id === act.value || s.name === act.value);
              const soundUrl = sound?.url || sound?.dataUrl || act.value;
              playSoundWithSharedContext(soundUrl);
            } else {
              playBeepWithSharedContext();
            }
          } catch (e) {
            console.warn("Sound error:", e);
          }
          break;
        }

        case "camera_follow": {
          if (act.target) setCameraFollowTarget(act.target);
          break;
        }
        case "camera_unfollow": {
          setCameraFollowTarget(null);
          break;
        }
        case "activate_joystick":
        case "deactivate_joystick":
        case "toggle_joystick_visibility": {
          if (act.target) {
            setStageElements((prev: any[]) => prev.map(el => {
              if (el.id === act.target) {
                return { ...el, hidden: act.type === "activate_joystick" ? false : act.type === "deactivate_joystick" ? true : !el.hidden };
              }
              return el;
            }));
          }
          break;
        }

        case 'stop_all_sounds': {
          stopAllActiveSounds();
          break;
        }

        case 'set_sound_volume': {
          if (act.value !== undefined) {
            masterSoundVolume = Math.max(0, Math.min(1, Number(act.value) / 100));
          }
          break;
        }

        case 'camera_control': {
          let targetX = globalCameraRef.current.x;
          let targetY = globalCameraRef.current.y;
          let targetZoom = globalCameraRef.current.zoom;
          
          if (act.value !== undefined && act.value !== '') {
            targetZoom = Number(act.value) / 100;
          }

          if (act.target) {
            const targetEl = stageElementsRef.current.find(el => el.id === act.target || el.data === act.target);
            if (targetEl) {
              targetX = -(targetEl.x + ((targetEl.width || 60) / 2) - (VIRTUAL_WIDTH / 2));
              targetY = -(targetEl.y + ((targetEl.height || 60) / 2) - (VIRTUAL_HEIGHT / 2));
            }
          } else {
            if (act.x !== undefined && act.x !== '') targetX = Number(act.x);
            if (act.y !== undefined && act.y !== '') targetY = Number(act.y);
          }

          setGlobalCamera({ zoom: targetZoom, x: targetX, y: targetY });
          break;
        }
        
        case 'reset_camera': {
          setGlobalCamera({ zoom: 1, x: 0, y: 0 });
          break;
        }

        case 'camera_shake': {
          const intensity = Number(act.intensity || 10);
          const durationSec = Number(act.duration || 0.4);
          
          let targetX = 0;
          let targetY = 0;
          let targetZoom = 1;
          
          if (act.value) {
            targetZoom = Number(act.value) / 100;
          }

          if (act.target) {
            const targetEl = stageElementsRef.current.find(el => el.id === act.target || el.data === act.target);
            if (targetEl) {
              targetX = -(targetEl.x + ((targetEl.width || 60) / 2) - (VIRTUAL_WIDTH / 2));
              targetY = -(targetEl.y + ((targetEl.height || 60) / 2) - (VIRTUAL_HEIGHT / 2));
            }
          } else if (act.x !== undefined || act.y !== undefined) {
            targetX = Number(act.x || 0);
            targetY = Number(act.y || 0);
          }
          
          setCameraShake({
            active: true,
            intensity,
            expiresAt: Date.now() + durationSec * 1000,
            zoom: targetZoom,
            panX: targetX,
            panY: targetY
          });
          break;
        }

        case 'flash_screen': {
          const color = act.color || '#ffffff';
          const duration = Number(act.duration || 0.3);
          setScreenFlash({
            active: true,
            color,
            duration,
            startedAt: Date.now()
          });
          setTimeout(() => {
            setScreenFlash(prev => ({ ...prev, active: false }));
          }, duration * 1000);
          break;
        }

        case 'show_floating_text': {
          if (act.value || act.text) {
            const floatId = `float_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            let posX = VIRTUAL_WIDTH / 2;
            let posY = VIRTUAL_HEIGHT / 2;
            if (act.target) {
              const targetEl = stageElementsRef.current.find(el => el.id === act.target || el.data === act.target);
              if (targetEl) {
                posX = targetEl.x + (targetEl.width || 60) / 2;
                posY = targetEl.y;
              }
            } else if (act.x !== undefined && act.y !== undefined) {
              posX = Number(act.x);
              posY = Number(act.y);
            }
            const newFloat = {
              id: floatId,
              text: act.value || act.text,
              x: posX,
              y: posY,
              color: act.color || '#facc15',
              fontSize: act.fontSize || 22,
              createdAt: Date.now()
            };
            setFloatingTexts(prev => [...prev, newFloat]);
            setTimeout(() => {
              setFloatingTexts(prev => prev.filter(f => f.id !== floatId));
            }, 1200);
          }
          break;
        }

        case 'move_to': {
          if (act.target) {
            const targetX = Number(act.x ?? 100);
            const targetY = Number(act.y ?? 100);
            setStageElements((prev) =>
              prev.map((el) =>
                el.data === act.target || el.id === act.target || el.buttonId === act.target
                  ? { ...el, x: targetX, y: targetY }
                  : el
              )
            );
          }
          break;
        }

        case 'move_straight':
        case 'move_zigzag': {
          if (act.target) {
            setStageElements((prev) =>
              prev.map((el) =>
                el.data === act.target || el.id === act.target || el.buttonId === act.target
                  ? { ...el, x: el.x + 80, y: el.y + (act.type === 'move_zigzag' ? 30 : 0) }
                  : el
              )
            );
          }
          break;
        }

        case 'move_straight_to':
        case 'move_zigzag_to': {
          if (act.target && act.value) {
            const speed = Number(act.speed || 150);
            setStageElements((prev) =>
              prev.map((el) => {
                if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                  return {
                    ...el,
                    movingTo: {
                      targetId: act.value,
                      speed,
                      isZigzag: act.type === 'move_zigzag_to'
                    }
                  };
                }
                return el;
              })
            );
          }
          break;
        }

        case 'move_left':
        case 'move_right':
        case 'move_up':
        case 'move_down': {
          if (act.target) {
            const dist = Number(act.value ?? act.distance ?? 25);
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                if (act.type === 'move_left') return { ...el, x: el.x - dist };
                if (act.type === 'move_right') return { ...el, x: el.x + dist };
                if (act.type === 'move_up') return { ...el, y: el.y - dist };
                if (act.type === 'move_down') return { ...el, y: el.y + dist };
                return el;
              }
              return el;
            }));
          }
          break;
        }

        case 'move_direction': {
          if (act.target) {
            const dist = Number(act.value ?? act.distance ?? 25);
            const dir = (act.direction || 'right').toLowerCase();
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                let nx = el.x, ny = el.y;
                if (dir === 'left') nx -= dist;
                else if (dir === 'right' || dir === 'side') nx += dist;
                else if (dir === 'up') ny -= dist;
                else if (dir === 'down') ny += dist;
                return { ...el, x: nx, y: ny };
              }
              return el;
            }));
          }
          break;
        }

        case 'flip_x': {
          if (act.target) {
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                return { ...el, flipX: !el.flipX };
              }
              return el;
            }));
          }
          break;
        }

        case 'flip_y': {
          if (act.target) {
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                return { ...el, flipY: !el.flipY };
              }
              return el;
            }));
          }
          break;
        }

        case 'scale_object': {
          if (act.target) {
            const scaleFactor = Number(act.value || 1.2);
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                return { ...el, width: Math.max(10, el.width * scaleFactor), height: Math.max(10, el.height * scaleFactor) };
              }
              return el;
            }));
          }
          break;
        }

        case 'add_impulse': {
          if (act.target) {
            const impulseX = Number(act.x ?? 0);
            const impulseY = Number(act.y ?? -200);
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                return {
                  ...el,
                  movingDirection: {
                    dirX: impulseX !== 0 ? Math.sign(impulseX) : 0,
                    dirY: impulseY !== 0 ? Math.sign(impulseY) : 0,
                    speed: Math.sqrt(impulseX * impulseX + impulseY * impulseY)
                  }
                };
              }
              return el;
            }));
          }
          break;
        }

        case 'shoot_direction': {
          const speed = Number(act.speed || 300);
          const dir = (act.direction || 'right').toLowerCase();
          let dirX = 0, dirY = 0;
          if (dir === 'up') { dirX = 0; dirY = -1; }
          else if (dir === 'down') { dirX = 0; dirY = 1; }
          else if (dir === 'left') { dirX = -1; dirY = 0; }
          else { dirX = 1; dirY = 0; }

          const shooterEl = stageElementsRef.current.find(el => el.data === act.target || el.id === act.target || el.buttonId === act.target);
          const startX = shooterEl ? shooterEl.x + (shooterEl.width || 60)/2 - 15 : VIRTUAL_WIDTH/2 - 15;
          const startY = shooterEl ? shooterEl.y + (shooterEl.height || 60)/2 - 15 : VIRTUAL_HEIGHT/2 - 15;
          const projectileObjId = act.projectile || act.value;

          if (projectileObjId) {
            setStageElements(prev => [
              ...prev,
              {
                id: `projectile_${Date.now()}_${Math.floor(Math.random()*1000)}`,
                type: 'obj',
                data: projectileObjId,
                x: startX,
                y: startY,
                width: 30,
                height: 30,
                movingDirection: { dirX, dirY, speed },
                layerId: ''
              }
            ]);
          } else if (shooterEl) {
            setStageElements(prev => prev.map(el => el.id === shooterEl.id ? { ...el, movingDirection: { dirX, dirY, speed } } : el));
          }
          break;
        }

        case 'shoot_towards': {
          const speed = Number(act.speed || 300);
          const shooterEl = stageElementsRef.current.find(el => el.data === (act.shooter || act.source) || el.id === (act.shooter || act.source));
          const targetEl = stageElementsRef.current.find(el => el.data === act.target || el.id === act.target);
          const startX = shooterEl ? shooterEl.x + (shooterEl.width || 60)/2 - 15 : VIRTUAL_WIDTH/2 - 15;
          const startY = shooterEl ? shooterEl.y + (shooterEl.height || 60)/2 - 15 : VIRTUAL_HEIGHT/2 - 15;

          let dirX = 1, dirY = 0;
          if (targetEl) {
            const dx = targetEl.x + (targetEl.width || 60)/2 - startX;
            const dy = targetEl.y + (targetEl.height || 60)/2 - startY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist > 0) { dirX = dx/dist; dirY = dy/dist; }
          }
          const projectileObjId = act.projectile || act.value || (shooterEl ? shooterEl.data : undefined);

          setStageElements(prev => [
            ...prev,
            {
              id: `projectile_${Date.now()}_${Math.floor(Math.random()*1000)}`,
              type: 'obj',
              data: projectileObjId || (gameData.gameObjects?.[0]?.id || 'default'),
              x: startX,
              y: startY,
              width: 30,
              height: 30,
              movingDirection: { dirX, dirY, speed },
              layerId: ''
            }
          ]);
          break;
        }

        case 'stop_movement': {
          if (act.target) {
            setStageElements((prev) =>
              prev.map((el) => {
                if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                  const next = { ...el };
                  delete next.movingTo;
                  delete next.movingDirection;
                  return next;
                }
                return el;
              })
            );
          }
          break;
        }

        case 'increase_speed': {
          if (act.target) {
            setStageElements((prev) =>
              prev.map((el) => {
                if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                  return {
                    ...el,
                    animationSpeedMultiplier: (el.animationSpeedMultiplier || 1) + Number(act.value || 0.5)
                  };
                }
                return el;
              })
            );
          }
          break;
        }

        case 'change_animation': {
          if (act.target && act.value !== undefined) {
            setStageElements((prev) =>
              prev.map((el) =>
                el.data === act.target || el.id === act.target || el.buttonId === act.target
                  ? { ...el, activeAnimationIndex: Number(act.value) }
                  : el
              )
            );
          }
          break;
        }

        case 'vibrate': {
          if (act.target) {
            setStageElements((prev) =>
              prev.map((el) =>
                el.data === act.target || el.id === act.target || el.buttonId === act.target
                  ? { ...el, vibrating: act.value === 'once' ? 'once' : 'continuous' }
                  : el
              )
            );
            if (act.value === 'once') {
              setTimeout(() => {
                setStageElements((prev) =>
                  prev.map((el) => {
                    if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                      const next = { ...el };
                      delete next.vibrating;
                      return next;
                    }
                    return el;
                  })
                );
              }, 5000);
            }
          }
          break;
        }

        case 'stop_vibration': {
          if (act.target) {
            setStageElements((prev) =>
              prev.map((el) => {
                if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                  const next = { ...el };
                  delete next.vibrating;
                  return next;
                }
                return el;
              })
            );
          }
          break;
        }

        case 'change_color': {
          if (act.target && act.value) {
            setStageElements((prev) =>
              prev.map((el) =>
                el.data === act.target || el.id === act.target || el.buttonId === act.target
                  ? { ...el, customColor: act.value }
                  : el
              )
            );
          }
          break;
        }

        case 'glow': {
          if (act.target && act.value) {
            setStageElements((prev) =>
              prev.map((el) =>
                el.data === act.target || el.id === act.target || el.buttonId === act.target
                  ? { ...el, glowColor: act.value }
                  : el
              )
            );
          }
          break;
        }

        case 'stop_glow': {
          if (act.target) {
            setStageElements((prev) =>
              prev.map((el) => {
                if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                  const next = { ...el };
                  delete next.glowColor;
                  return next;
                }
                return el;
              })
            );
          }
          break;
        }

        case 'show_text': {
          if (act.value) {
            const textId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            let textX = VIRTUAL_WIDTH / 2 - 100;
            let textY = VIRTUAL_HEIGHT / 2 - 25;

            if (act.positionMode === 'character' && act.target) {
              const targetEl = stageElementsRef.current.find(
                (el) => el.id === act.target || el.data === act.target || el.buttonId === act.target
              );
              if (targetEl) {
                textX = targetEl.x + (targetEl.width || 0) / 2 - 100;
                textY = targetEl.y - 60;
              }
            } else if (act.x !== undefined && act.y !== undefined) {
              textX = Number(act.x);
              textY = Number(act.y);
            }

            setStageElements((prev) => [
              ...prev,
              {
                id: textId,
                type: 'toast',
                text: act.value,
                x: textX,
                y: textY,
                width: 200,
                height: 50,
                isToast: true,
                style: {
                  color: act.color || '#ffff00',
                  fontSize: act.fontSize ? `${act.fontSize}px` : '20px',
                  fontFamily: act.fontFamily || 'sans-serif',
                  fontWeight: act.bold ? 'bold' : 'normal',
                  fontStyle: act.italic ? 'italic' : 'normal',
                  background: act.background || 'black'
                }
              }
            ]);
          }
          break;
        }

        case 'delete_text': {
          if (act.target) {
            setStageElements((prev) =>
              prev.filter((el) => el.data !== act.target && el.id !== act.target && el.buttonId !== act.target)
            );
          } else {
            setStageElements((prev) => prev.filter((el) => el.type !== 'toast' && !el.isToast));
          }
          break;
        }

        case 'rotate': {
          if (act.target) {
            const rotationDegrees = Number(act.value ?? 15);
            setStageElements((prev) =>
              prev.map((el) =>
                el.data === act.target || el.id === act.target || el.buttonId === act.target
                  ? { ...el, rotation: (el.rotation || 0) + rotationDegrees }
                  : el
              )
            );
          }
          break;
        }

        case 'inc_width': {
          if (act.target) {
            const addWidth = Number(act.value ?? 10);
            setStageElements((prev) =>
              prev.map((el) =>
                el.data === act.target || el.id === act.target || el.buttonId === act.target
                  ? { ...el, width: el.width + addWidth }
                  : el
              )
            );
          }
          break;
        }

        case 'inc_height': {
          if (act.target) {
            const addHeight = Number(act.value ?? 10);
            setStageElements((prev) =>
              prev.map((el) =>
                el.data === act.target || el.id === act.target || el.buttonId === act.target
                  ? { ...el, height: el.height + addHeight }
                  : el
              )
            );
          }
          break;
        }

        case 'create_character': {
          if (act.target) {
            const targetObj = (gameData.gameObjects || []).find((g: any) => g.id === act.target);
            if (targetObj) {
              const newId = `created_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              setStageElements((prev) => [
                ...prev,
                {
                  id: newId,
                  type: 'obj',
                  data: act.target,
                  x: Number(act.x ?? 100),
                  y: Number(act.y ?? 100),
                  width: 100,
                  height: 100,
                  zIndex: 10
                }
              ]);
            }
          }
          break;
        }

        case 'play_animation':
        case 'play_video': {
          if (act.target) {
            const videoId = act.target;
            const fitToScreen = act.fitToScreen || false;
            const loop = act.loop ?? false;
            const muted = act.muted ?? false;
            const volume = act.volume !== undefined ? Number(act.volume) / 100 : 1;
            const speed = act.speed !== undefined ? Number(act.speed) : 1;
            const videoSrc = resolveVideoUrl(videoId);

            const existing = stageElementsRef.current.find((el) => el.type === 'video' && (el.videoId === videoId || el.id === videoId));
            if (existing) {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) {
                elVid.currentTime = 0;
                playVideoElementSafely(elVid, { loop, muted, volume, speed });
              }
            } else {
              const elId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              setStageElements((prev) => [
                ...prev,
                {
                  id: elId,
                  type: 'video',
                  videoId: videoId,
                  url: videoSrc,
                  fitToScreen: fitToScreen,
                  loop: loop,
                  muted: muted,
                  volume: volume,
                  speed: speed,
                  x: fitToScreen ? 0 : Number(act.x ?? 100),
                  y: fitToScreen ? 0 : Number(act.y ?? 50),
                  width: fitToScreen ? VIRTUAL_WIDTH : Number(act.width ?? 320),
                  height: fitToScreen ? VIRTUAL_HEIGHT : Number(act.height ?? 180),
                  layerId: act.layerId || ''
                }
              ]);
              setTimeout(() => {
                const elVid = document.getElementById(`video_player_${elId}`) as HTMLVideoElement;
                if (elVid) {
                  elVid.currentTime = 0;
                  playVideoElementSafely(elVid, { loop, muted, volume, speed });
                }
              }, 80);
            }
          }
          break;
        }

        case 'pause_animation':
        case 'pause_video': {
          if (act.target) {
            const videoId = act.target;
            const existing = stageElementsRef.current.find((el) => el.type === 'video' && (el.videoId === videoId || el.id === videoId));
            if (existing) {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) elVid.pause();
            }
          } else {
            stageElementsRef.current.filter((el) => el.type === 'video').forEach((existing) => {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) elVid.pause();
            });
          }
          break;
        }

        case 'resume_animation':
        case 'resume_video': {
          if (act.target) {
            const videoId = act.target;
            const existing = stageElementsRef.current.find((el) => el.type === 'video' && (el.videoId === videoId || el.id === videoId));
            if (existing) {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) playVideoElementSafely(elVid);
            }
          } else {
            stageElementsRef.current.filter((el) => el.type === 'video').forEach((existing) => {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) playVideoElementSafely(elVid);
            });
          }
          break;
        }

        case 'stop_animation':
        case 'stop_video': {
          if (act.target) {
            const videoId = act.target;
            const existing = stageElementsRef.current.find((el) => el.type === 'video' && (el.videoId === videoId || el.id === videoId));
            if (existing) {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) {
                elVid.pause();
                elVid.currentTime = 0;
              }
            }
          } else {
            stageElementsRef.current.filter((el) => el.type === 'video').forEach((existing) => {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) {
                elVid.pause();
                elVid.currentTime = 0;
              }
            });
          }
          break;
        }

        case 'remove_animation':
        case 'remove_video': {
          if (act.target) {
            const videoId = act.target;
            setStageElements((prev) => prev.filter((el) => !(el.type === 'video' && (el.videoId === videoId || el.id === videoId))));
          } else {
            setStageElements((prev) => prev.filter((el) => el.type !== 'video'));
          }
          break;
        }

        case 'set_video_volume': {
          const vol = Math.max(0, Math.min(1, Number(act.value ?? 100) / 100));
          if (act.target) {
            const videoId = act.target;
            const existing = stageElementsRef.current.find((el) => el.type === 'video' && (el.videoId === videoId || el.id === videoId));
            if (existing) {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) elVid.volume = vol;
            }
          }
          break;
        }

        case 'set_video_speed': {
          const speed = Math.max(0.25, Math.min(4, Number(act.value ?? 1)));
          if (act.target) {
            const videoId = act.target;
            const existing = stageElementsRef.current.find((el) => el.type === 'video' && (el.videoId === videoId || el.id === videoId));
            if (existing) {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) elVid.playbackRate = speed;
            }
          }
          break;
        }

        case 'seek_video': {
          const sec = Math.max(0, Number(act.value ?? 0));
          if (act.target) {
            const videoId = act.target;
            const existing = stageElementsRef.current.find((el) => el.type === 'video' && (el.videoId === videoId || el.id === videoId));
            if (existing) {
              const elVid = document.getElementById(`video_player_${existing.id}`) as HTMLVideoElement;
              if (elVid) elVid.currentTime = sec;
            }
          }
          break;
        }

        case 'create_character': {
          if (act.value) {
            const objId = act.value;
            const newId = `char_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            setStageElements(prev => [
              ...prev,
              {
                id: newId,
                type: 'obj',
                data: objId,
                x: Number(act.x ?? 100),
                y: Number(act.y ?? 100),
                width: 60,
                height: 60,
                layerId: gameData.layers?.[0]?.id || 'layer_1'
              }
            ]);
          }
          break;
        }

        case 'increase_speed': {
          if (act.target) {
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                const mult = Number(act.value ?? 1.5);
                return { ...el, animationSpeedMultiplier: (el.animationSpeedMultiplier || 1) * mult };
              }
              return el;
            }));
          }
          break;
        }

        case 'vibrate': {
          if (act.target) {
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                return { ...el, vibrating: act.value === 'once' ? 'once' : 'infinite' };
              }
              return el;
            }));
          }
          break;
        }

        case 'stop_vibration': {
          if (act.target) {
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                const newEl = { ...el };
                delete (newEl as any).vibrating;
                return newEl;
              }
              return el;
            }));
          }
          break;
        }

        case 'inc_width': {
          if (act.target) {
            const amount = Number(act.value ?? 10);
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                return { ...el, width: (el.width || 0) + amount };
              }
              return el;
            }));
          }
          break;
        }

        case 'inc_height': {
          if (act.target) {
            const amount = Number(act.value ?? 10);
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                return { ...el, height: (el.height || 0) + amount };
              }
              return el;
            }));
          }
          break;
        }

        case 'rotate': {
          if (act.target) {
            const rotationDegrees = Number(act.value ?? 15);
            setStageElements(prev => prev.map(el => {
              if (el.data === act.target || el.id === act.target || el.buttonId === act.target) {
                return { ...el, rotation: (el.rotation || 0) + rotationDegrees };
              }
              return el;
            }));
          }
          break;
        }

        case 'toggle_var': {
          if (act.target) {
            setVariables(prev => prev.map(v => (v.id === act.target || v.name === act.target) ? { ...v, value: !v.value } : v));
          }
          break;
        }

        case 'random_number': {
          if (act.target) {
            const min = Number(act.min ?? 0);
            const max = Number(act.max ?? 100);
            const val = Math.floor(Math.random() * (max - min + 1)) + min;
            setVariables(prev => prev.map(v => (v.id === act.target || v.name === act.target) ? { ...v, value: val } : v));
          }
          break;
        }

        case 'js': {
          /*
            Available variables/functions in Custom JS:
            - stageElements: Array of elements on the current stage
            - setStageElements: Function to update stage elements
            - activeSceneId: Current scene ID
            - handleSwitchScene: Function(sceneId) to switch scene
            - events: Array of scene events
            - setEvents: Function to update events
            - gameObjects: Array of global game objects
            - setGameObjects: Function to update game objects
            - layers: Array of scene layers
            - setLayers: Function to update layers
            - activeLayerId: Current active layer ID
            - setActiveLayerId: Function to set active layer
            - playSound: Function(soundId) to play a sound
            - variables: Object containing game variables
            - setVariables: Function to update variables
          */
          if (act.code) {
            try {
              const runUserCode = new Function(
                'stageElements', 'setStageElements', 
                'activeSceneId', 'handleSwitchScene',
                'events', 'setEvents',
                'gameObjects', 'setGameObjects',
                'layers', 'setLayers',
                'activeLayerId', 'setActiveLayerId',
                'playSound',
                'variables', 'setVariables',
                act.code
              );
              
              const dummySet = () => {};
              
              runUserCode(
                stageElementsRef.current,
                setStageElements,
                activeSceneIdRef.current,
                setActiveSceneId,
                (gameData.sceneEvents && gameData.sceneEvents[activeSceneIdRef.current]) || [],
                dummySet,
                gameData.gameObjects || [],
                dummySet,
                gameData.layers || [],
                dummySet,
                '',
                dummySet,
                playSoundWithSharedContext,
                variablesRef.current,
                setVariables
              );
            } catch (err: any) {
              console.error("Custom JS Error:", err);
              alert("Your custom JavaScript code has an error:\n" + err.message);
            }
          }
          break;
        }

        default:
          console.log("Unhandled action:", act.type);
      }
    };

    const repeatCount = act.repeat ? Number(act.repeat) : 1;
    const waitTime = act.wait_for ? Number(act.wait_for) * 1000 : 0;
    
    for (let i = 0; i < repeatCount; i++) {
      if (waitTime > 0) {
        setTimeout(() => doAction(), waitTime + (i * waitTime));
      } else {
        doAction();
      }
    }
  };

  // Button & Interactive Click Handler
  const handleElementClick = (elementId: string) => {
    if (!elementId) return;
    const btnEl = stageElementsRef.current.find((e) => e.id === elementId);
    const sceneEvents = (gameData.sceneEvents && (gameData.sceneEvents as any)[activeSceneId]) || [];

    sceneEvents.forEach((ev: any) => {
      if (evaluateEventConditions(ev, {
        type: 'click',
        targetId: elementId,
        targetData: btnEl?.data,
        targetBtnId: (btnEl as any)?.buttonId
      }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
        ev.actions?.forEach((act: any) => executeAction(act));
      }
    });
  };

  // Keyboard Listener (Press, Continuous Hold & Release)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const code = e.code.toLowerCase();
      activeKeysDown.current.add(key);
      activeKeysDown.current.add(code);
      if (key === ' ') activeKeysDown.current.add('space');

      const sceneEvents = (gameData.sceneEvents && (gameData.sceneEvents as any)[activeSceneId]) || [];
      sceneEvents.forEach((ev: any) => {
        if (evaluateEventConditions(ev, {
          type: 'key_down',
          key,
          code
        }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
          ev.actions?.forEach((act: any) => executeAction(act));
        }
      });
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const code = e.code.toLowerCase();
      activeKeysDown.current.delete(key);
      activeKeysDown.current.delete(code);
      if (key === ' ') activeKeysDown.current.delete('space');

      const sceneEvents = (gameData.sceneEvents && (gameData.sceneEvents as any)[activeSceneId]) || [];
      sceneEvents.forEach((ev: any) => {
        if (evaluateEventConditions(ev, {
          type: 'key_up',
          key,
          code
        }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
          ev.actions?.forEach((act: any) => executeAction(act));
        }
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [activeSceneId]);

  // Pointer Events for Swipe and Touch
  const handlePointerDown = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch (_) {}

    isSwipingActiveRef.current = false;
    const targetEl = (e.target as HTMLElement)?.closest('[data-element-id]') as HTMLElement | null;
    const targetId = targetEl?.getAttribute('data-element-id') || undefined;
    const targetData = targetEl?.getAttribute('data-element-data') || undefined;
    const targetBtnId = targetEl?.getAttribute('data-btn-id') || undefined;

    touchStartPosRef.current = {
      x: e.clientX,
      y: e.clientY,
      time: Date.now(),
      targetId,
      targetData,
      targetBtnId
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const start = touchStartPosRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) >= 15) {
      isSwipingActiveRef.current = true;
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const start = touchStartPosRef.current;
    if (!start) return;

    try {
      if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      }
    } catch (_) {}

    touchStartPosRef.current = null;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const distance = Math.hypot(dx, dy);
    const duration = Date.now() - start.time;

    // Using unified 20px threshold
    const isSwipe = isSwipingActiveRef.current || distance >= 20;
    let swipeDir: 'left' | 'right' | 'up' | 'down' | undefined = undefined;
    if (isSwipe) {
      swipeDir = absX >= absY ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }

    const isTap = !isSwipe && duration < 600;
    const targetEl = (e.target as HTMLElement)?.closest('[data-element-id]') as HTMLElement | null;
    const currentTargetId = targetEl?.getAttribute('data-element-id') || undefined;
    const currentTargetData = targetEl?.getAttribute('data-element-data') || undefined;
    const currentTargetBtnId = targetEl?.getAttribute('data-btn-id') || undefined;

    const finalTargetId = start.targetId || currentTargetId;
    const finalTargetData = start.targetData || currentTargetData;
    const finalTargetBtnId = start.targetBtnId || currentTargetBtnId;

    if (isTap) {
      const now = Date.now();
      const lastTap = lastTapRef.current;
      const isDoubleTap = !!(lastTap && 
        (now - lastTap.time < 350) && 
        Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30 &&
        lastTap.targetId === finalTargetId);

      if (isDoubleTap) {
        if (tapTimeoutRef.current) {
          clearTimeout(tapTimeoutRef.current);
          tapTimeoutRef.current = null;
        }
        lastTapRef.current = null;
        
        const sceneEvents = (gameData.sceneEvents && (gameData.sceneEvents as any)[activeSceneId]) || [];
        sceneEvents.forEach((ev: any) => {
          if (evaluateEventConditions(ev, {
            type: 'pointer_up',
            isTap: true,
            isDoubleTap: true,
            targetId: finalTargetId,
            targetData: finalTargetData,
            targetBtnId: finalTargetBtnId
          }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
            ev.actions?.forEach((act: any) => executeAction(act));
          }
        });
      } else {
        lastTapRef.current = { time: now, x: e.clientX, y: e.clientY, targetId: finalTargetId };
        
        const sceneEvents = (gameData.sceneEvents && (gameData.sceneEvents as any)[activeSceneId]) || [];
        const hasDoubleTapListener = sceneEvents.some((ev: any) => 
          ev.conditions?.some((c: any) => c.type === 'double_tap')
        );

        const emitSingleTap = () => {
          tapTimeoutRef.current = null;
          sceneEvents.forEach((ev: any) => {
            if (evaluateEventConditions(ev, {
              type: 'pointer_up',
              isTap: true,
              isDoubleTap: false,
              targetId: finalTargetId,
              targetData: finalTargetData,
              targetBtnId: finalTargetBtnId
            }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
              ev.actions?.forEach((act: any) => executeAction(act));
            }
          });
        };

        if (hasDoubleTapListener) {
          tapTimeoutRef.current = setTimeout(emitSingleTap, 250);
        } else {
          emitSingleTap();
        }
      }
    } else {
      const sceneEvents = (gameData.sceneEvents && (gameData.sceneEvents as any)[activeSceneId]) || [];
      sceneEvents.forEach((ev: any) => {
        if (evaluateEventConditions(ev, {
          type: 'pointer_up',
          swipeDir: isSwipe ? swipeDir : undefined,
          isTap: false,
          targetId: finalTargetId,
          targetData: finalTargetData,
          targetBtnId: finalTargetBtnId
        }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
          ev.actions?.forEach((act: any) => executeAction(act));
        }
      });
    }

    if (isSwipe) {
      setTimeout(() => {
        isSwipingActiveRef.current = false;
      }, 100);
    } else {
      isSwipingActiveRef.current = false;
    }
  };

  const handlePointerCancel = (e: React.PointerEvent) => {
    const start = touchStartPosRef.current;
    if (!start) return;

    try {
      if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      }
    } catch (_) {}

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const distance = Math.hypot(dx, dy);
    touchStartPosRef.current = null;

    const isSwipe = isSwipingActiveRef.current || distance >= 20;
    if (isSwipe) {
      const swipeDir = absX >= absY ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      const sceneEvents = (gameData.sceneEvents && (gameData.sceneEvents as any)[activeSceneId]) || [];
      sceneEvents.forEach((ev: any) => {
        if (evaluateEventConditions(ev, {
          type: 'pointer_up',
          swipeDir,
          isTap: false,
          targetId: start.targetId,
          targetData: start.targetData,
          targetBtnId: start.targetBtnId
        }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
          ev.actions?.forEach((act: any) => executeAction(act));
        }
      });
    }
    
    setTimeout(() => {
      isSwipingActiveRef.current = false;
    }, 100);
  };

  const evaluateSingleCondition = (cond: any, evKey: string) => {
    if (cond.type === 'timer') {
      const t = timersRef.current.find((item: any) => item.id === cond.target || item.name === cond.target);
      if (!t || t.time < Number(cond.value || 0)) return false;
    } else if (cond.type === 'wait_seconds') {
      if (timerValuesRef.current.scene_timer < Number(cond.value || 0)) return false;
    } else if (cond.type === 'every_x_seconds') {
      const period = Math.max(0.05, Number(cond.value || cond.seconds || 1));
      const pKey = evKey + '_every_x';
      const lastFired = periodicTimersRef.current[pKey] || 0;
      if (timerValuesRef.current.scene_timer - lastFired < period) {
        return false;
      }
    } else if (cond.type === 'variable') {
      const targetVar = variablesRef.current.find((v: any) => v.id === cond.target || v.name === cond.target);
      if (targetVar) {
        let varVal: any = targetVar.value;
        let condVal: any = cond.value;
        if (targetVar.type === 'number') { varVal = Number(varVal ?? 0); condVal = Number(condVal ?? 0); }
        else if (targetVar.type === 'boolean') { varVal = String(varVal) === 'true'; condVal = String(condVal) === 'true'; }
        else { varVal = String(varVal ?? ''); condVal = String(condVal ?? ''); }
        const op = cond.operator || '==';
        let match = false;
        if (op === '==') match = varVal == condVal;
        else if (op === '!=') match = varVal != condVal;
        else if (op === '>') match = Number(varVal) > Number(condVal);
        else if (op === '<') match = Number(varVal) < Number(condVal);
        else if (op === '>=') match = Number(varVal) >= Number(condVal);
        else if (op === '<=') match = Number(varVal) <= Number(condVal);
        if (!match) return false;
      } else return false;
    } else if (cond.type === 'collision') {
      const el1 = stageElementsRef.current.find((el: any) => el.data === cond.target || el.id === cond.target);
      const el2 = stageElementsRef.current.find((el: any) => el.data === cond.target2 || el.id === cond.target2);
      if (el1 && el2) {
        const collides = !(el1.x + el1.width < el2.x || el2.x + el2.width < el1.x || el1.y + el1.height < el2.y || el2.y + el2.height < el1.y);
        if (!collides) return false;
      } else return false;
    } else if (cond.type === 'distance_less_than') {
      const el1 = stageElementsRef.current.find((el: any) => el.data === cond.target || el.id === cond.target);
      const el2 = stageElementsRef.current.find((el: any) => el.data === cond.target2 || el.id === cond.target2);
      if (el1 && el2) {
        const dx = (el1.x + el1.width/2) - (el2.x + el2.width/2);
        const dy = (el1.y + el1.height/2) - (el2.y + el2.height/2);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= Number(cond.value || 100)) return false;
      } else return false;
    } else if (cond.type === 'outside_screen') {
      const targetEl = stageElementsRef.current.find((el: any) => el.data === cond.target || el.id === cond.target);
      if (targetEl) {
        const isOutside = targetEl.x + targetEl.width < 0 || targetEl.x > VIRTUAL_WIDTH || targetEl.y + targetEl.height < 0 || targetEl.y > VIRTUAL_HEIGHT;
        if (!isOutside) return false;
      } else return false;
    } else if (cond.type === 'opacity') {
      const targetEl = stageElementsRef.current.find((el: any) => el.data === cond.target || el.id === cond.target);
      if (!targetEl || Math.abs((targetEl.opacity ?? 1) - Number(cond.value || 100)/100) >= 0.01) return false;
    } else if (cond.type === 'color') {
      const targetEl = stageElementsRef.current.find((el: any) => el.data === cond.target || el.id === cond.target);
      if (!targetEl || (targetEl as any).customColor !== cond.value) return false;
    } else if (cond.type === 'is_visible') {
      const targetEl = stageElementsRef.current.find((el: any) => el.data === cond.target || el.id === cond.target);
      if (!targetEl || targetEl.opacity === 0) return false;
    } else if (cond.type === 'animation') {
      const targetEl = stageElementsRef.current.find((el: any) => el.data === cond.target || el.id === cond.target);
      if (!targetEl || String((targetEl as any).activeAnimationIndex || 0) !== String(cond.value)) return false;
    } else if (cond.type === 'position' || cond.type === 'created') {
      const targetEl = stageElementsRef.current.find((el: any) => el.data === cond.target || el.id === cond.target);
      if (!targetEl) {
        return false;
      } else {
        const tolerance = Number(cond.tolerance) > 0 ? Number(cond.tolerance) : 10;
        const hasX = cond.x !== undefined && cond.x !== '' && cond.x !== null;
        const hasY = cond.y !== undefined && cond.y !== '' && cond.y !== null;
        if (hasX && Math.abs(targetEl.x - Number(cond.x)) > tolerance) return false;
        if (hasY && Math.abs(targetEl.y - Number(cond.y)) > tolerance) return false;
      }
    } else if (cond.type === 'video_playing') {
      const videoEl = stageElementsRef.current.find((el: any) => el.type === 'video' && (el.videoId === cond.target || el.id === cond.target || !cond.target));
      if (!videoEl) return false;
    } else if (cond.type === 'loop') {
      const loopKey = 'loop_' + evKey + '_' + (cond.target || 'def');
      if (!timerValuesRef.current[loopKey]) timerValuesRef.current[loopKey] = 0;
      if (timerValuesRef.current[loopKey] >= Number(cond.value || 1)) {
        return false;
      } else {
        timerValuesRef.current[loopKey]++;
      }
    }
    return true;
  };

  // Main 60FPS Physics / Timer / Condition Loop
  useEffect(() => {
    const sceneEvents = (gameData.sceneEvents && (gameData.sceneEvents as any)[activeSceneId]) || [];

    // Fire scene_start events immediately
    sceneEvents.forEach((ev: any) => {
      if (evaluateEventConditions(ev, {
        type: 'scene_start'
      }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
        ev.actions?.forEach((act: any) => executeAction(act));
      }
    });

    let lastTime = Date.now();
    timerValuesRef.current = { scene_timer: 0 };
    periodicTimersRef.current = {};
    const triggeredEvents = new Set<string>();

    const interval = setInterval(() => {
      const now = Date.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      timerValuesRef.current.scene_timer += dt;

      // --- CAMERA FOLLOW LOGIC ---
      if (cameraFollowTargetRef.current && stageElementsRef.current) {
        const targetEl = stageElementsRef.current.find(el => el.id === cameraFollowTargetRef.current || el.data === cameraFollowTargetRef.current);
        if (targetEl) {
          const targetCX = (targetEl.x || 0) + (targetEl.width || 50) / 2;
          const targetCY = (targetEl.y || 0) + (targetEl.height || 50) / 2;
          
          setGlobalCamera(cam => {
            const targetX = (VIRTUAL_WIDTH / 2) - targetCX;
            const targetY = (VIRTUAL_HEIGHT / 2) - targetCY;
            const nextX = cam.x + (targetX - cam.x) * 5 * dt;
            const nextY = cam.y + (targetY - cam.y) * 5 * dt;
            const clamped = clampCameraToBounds(nextX, nextY, cam.zoom, stageElementsRef.current || [], VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
            return { ...cam, x: clamped.x, y: clamped.y };
          });
        }
      }

      // 1. Advance Active Timers
      setTimers((prev) =>
        prev.map((t) => (t.state === 'playing' ? { ...t, time: (t.time || 0) + dt } : t))
      );

      // 2. Continuous Key Holds (WASD / Arrows smooth movement)
      if (activeKeysDown.current.size > 0) {
        sceneEvents.forEach((ev: any) => {
          if (evaluateEventConditions(ev, {
            type: 'key_held_tick'
          }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
            ev.actions?.forEach((act: any) => executeAction(act));
          }
        });
      }

      // 3. Physics & Motion Updates
      setStageElements((prevElements) => {
        let hasChanges = false;
        
        // --- JOYSTICK INTERACTION ---
        const activeJoysticks = prevElements.filter((el: any) => el.type === 'joystick' && !el.hidden);
        activeJoysticks.forEach((joyEl: any) => {
          const joyState = joystickStatesRef.current[joyEl.id];
          if (joyState && joyState.active && joyState.distance > 0.05) {
            const joyConfig = gameData.joysticks?.find((j: any) => j.id === joyEl.joystickId) || joyEl;
            const isCamJoy = joyEl.joystickType === 'camera' || 
                             joyEl.type === 'camera' || 
                             joyConfig.type === 'camera' || 
                             joyEl.interactionType === 'pan' || 
                             joyEl.interactionType === 'pan_camera' || 
                             joyEl.interactionType === 'zoom' || 
                             joyConfig.interactionType === 'pan' || 
                             joyConfig.interactionType === 'pan_camera' || 
                             joyConfig.interactionType === 'zoom';
            const interactionType = joyEl.interactionType || joyConfig.interactionType || (isCamJoy ? 'pan' : 'move');
            const speed = Number(joyEl.speed || joyConfig.speed || (interactionType === 'rotate' ? 180 : 160));
            let targetId = joyEl.attachedObjectId || joyConfig.attachedObjectId;

            if (isCamJoy || interactionType === 'pan' || interactionType === 'pan_camera' || interactionType === 'zoom') {
              if (interactionType === 'zoom') {
                setGlobalCamera((cam: any) => {
                  const nextZoom = Math.max(0.2, Math.min(3, cam.zoom + (-joyState.normY) * 1.0 * dt));
                  const clamped = clampCameraToBounds(cam.x, cam.y, nextZoom, prevElements, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
                  return { zoom: nextZoom, x: clamped.x, y: clamped.y };
                });
              } else {
                setGlobalCamera((cam: any) => {
                  const nextX = cam.x - joyState.normX * speed * dt;
                  const nextY = cam.y - joyState.normY * speed * dt;
                  const clamped = clampCameraToBounds(nextX, nextY, cam.zoom, prevElements, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
                  return { ...cam, x: clamped.x, y: clamped.y };
                });
              }
            } else {
              if (!targetId) {
                const defaultTarget = prevElements.find((el: any) => (el.type === 'obj' || el.type === 'character') && !el.hidden);
                if (defaultTarget) targetId = defaultTarget.id;
              }
              if (targetId) {
                const targetIdx = prevElements.findIndex((el: any) => el.id === targetId || el.data === targetId);
                if (targetIdx >= 0) {
                  const target = prevElements[targetIdx];
                  if (interactionType === 'move') {
                    target.x = (target.x || 0) + joyState.normX * speed * dt;
                    target.y = (target.y || 0) + joyState.normY * speed * dt;
                    const shouldFlip = joyEl.flipOnMove !== false && joyConfig.flipOnMove !== false;
                    if (shouldFlip) {
                      if (joyState.normX < -0.15) {
                        target.flipX = true;
                        target.scaleX = -Math.abs(target.scaleX || 1);
                      } else if (joyState.normX > 0.15) {
                        target.flipX = false;
                        target.scaleX = Math.abs(target.scaleX || 1);
                      }
                    }
                  } else if (interactionType === 'rotate') {
                    target.rotation = joyState.angle;
                  } else if (interactionType === 'scale') {
                    target.scale = Math.max(0.2, Math.min(3, (target.scale || 1) + (-joyState.normY) * 1.5 * dt));
                  } else if (interactionType === 'aim') {
                    target.rotation = joyState.angle;
                  }
                  hasChanges = true;
                }
              }
            }
          }
        });

        // --- ATTACHMENTS ---
        const activeAtts = gameData.sceneAttachments?.[activeSceneId] || gameData.attachments || [];
        activeAtts.forEach((att: any) => {
          if (!att.childElementId || !att.parentElementId) return;
          const pIdx = prevElements.findIndex((el: any) => el.id === att.parentElementId || el.data === att.parentElementId);
          const cIdx = prevElements.findIndex((el: any) => el.id === att.childElementId || el.data === att.childElementId);
          if (pIdx >= 0 && cIdx >= 0 && pIdx !== cIdx) {
            const parent = prevElements[pIdx];
            const child = prevElements[cIdx];
            const pCenterX = (parent.x || 0) + (parent.width || 50) / 2;
            const pCenterY = (parent.y || 0) + (parent.height || 50) / 2;
            const pRotRad = ((parent.rotation || 0) * Math.PI) / 180;
            const flipX = (parent.scaleX !== undefined && parent.scaleX < 0) ? -1 : 1;
            const rotatedX = (att.offsetX || 0) * flipX * Math.cos(pRotRad) - (att.offsetY || 0) * Math.sin(pRotRad);
            const rotatedY = (att.offsetX || 0) * flipX * Math.sin(pRotRad) + (att.offsetY || 0) * Math.cos(pRotRad);
            
            child.x = pCenterX + rotatedX - (child.width || 50) / 2;
            child.y = pCenterY + rotatedY - (child.height || 50) / 2;
            if (att.followRotation) child.rotation = ((parent.rotation || 0) + (att.offsetRotation || 0)) * flipX;
            if (att.followFlip) child.scaleX = flipX * Math.abs(child.scaleX || 1);
            if (att.followScale && parent.scale !== undefined) child.scale = parent.scale;
            
            if (att.aimTowardsJoystick) {
               const aimingJoy = activeJoysticks.find((joy: any) => (joy.attachedObjectId === child.id || joy.attachedObjectId === child.data));
               if (aimingJoy) {
                  const joyState = joystickStatesRef.current[aimingJoy.id];
                  if (joyState && joyState.active) child.rotation = joyState.angle;
               }
            }
            hasChanges = true;
          }
        });

        const nextElements = prevElements.map((el) => {
          let updatedEl = { ...el };
          let changed = false;

          // --- SCREEN BOUNDARY & ENEMY LOGIC ---
          const isEnemy = gameData.gameObjects?.find((go: any) => go.id === el.data)?.type === 'enemy';
          const isFollowingThis = cameraFollowTargetRef.current === el.id || cameraFollowTargetRef.current === el.data;
          const margin = 100;

          // Calculate viewport in world coordinates
          const cam = globalCameraRef.current;
          const viewLeft = -cam.x / cam.zoom;
          const viewTop = -cam.y / cam.zoom;
          const viewRight = (-cam.x + VIRTUAL_WIDTH) / cam.zoom;
          const viewBottom = (-cam.y + VIRTUAL_HEIGHT) / cam.zoom;

          if (isEnemy) {
             if (!isFollowingThis && (el.x < viewLeft - margin || el.x > viewRight + margin || el.y < viewTop - margin || el.y > viewBottom + margin)) {
                hasChanges = true;
                return null;
             }
          } else if (!isFollowingThis && el.type === 'obj') {
             const oldX = el.x;
             const oldY = el.y;
             updatedEl.x = Math.max(viewLeft, Math.min(viewRight - (el.width || 0), el.x));
             updatedEl.y = Math.max(viewTop, Math.min(viewBottom - (el.height || 0), el.y));
             if (updatedEl.x !== oldX || updatedEl.y !== oldY) {
                changed = true;
                if (updatedEl.movingDirection) updatedEl.movingDirection.speed = 0;
             }
          }

          if (el.movingTo && el.movingTo.targetId) {
            const targetEl = prevElements.find((t) => t.id === el.movingTo.targetId || t.data === el.movingTo.targetId);
            if (targetEl) {
              const dx = targetEl.x - el.x, dy = targetEl.y - el.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist > 5) {
                const moveDist = (el.movingTo.speed || 150) * dt;
                let nx = el.x + (dx / dist) * moveDist, ny = el.y + (dy / dist) * moveDist;
                if (el.movingTo.isZigzag) {
                   const time = Date.now() / 1000;
                   const perpX = -dy / dist, perpY = dx / dist;
                   nx += perpX * Math.sin(time * 15) * 200 * dt;
                   ny += perpY * Math.sin(time * 15) * 200 * dt;
                }
                changed = true;
                updatedEl.x = nx;
                updatedEl.y = ny;
              }
            }
          }
          if (el.movingDirection) {
            const { dirX, dirY, speed } = el.movingDirection;
            changed = true;
            updatedEl.x = (updatedEl.x || el.x) + dirX * speed * dt;
            updatedEl.y = (updatedEl.y || el.y) + dirY * speed * dt;
          }
          if (changed) hasChanges = true;
          return changed ? updatedEl : el;
        });
        const filtered = nextElements.filter(Boolean);
        return hasChanges ? filtered : prevElements;
      });

      // 4. Condition Evaluations
      sceneEvents.forEach((ev: any, evIdx: number) => {
        if (!ev.conditions || ev.conditions.length === 0) return;
        const evKey = String(ev.id || evIdx);

        if (evaluateEventConditions(ev, {
          type: 'tick'
        }, evKey, { activeKeysDown: activeKeysDown.current, evaluateSingleCondition })) {
          const hasPeriodic = ev.conditions?.some((c: any) => c.type === 'every_x_seconds');
          if (hasPeriodic) {
            ev.conditions?.forEach((c: any) => {
              if (c.type === 'every_x_seconds') {
                const pKey = evKey + '_every_x';
                periodicTimersRef.current[pKey] = timerValuesRef.current.scene_timer;
              }
            });
            ev.actions?.forEach((act: any) => executeAction(act));
          } else if (!triggeredEvents.has(evKey) || ev.allowContinuousTrigger) {
            triggeredEvents.add(evKey);
            ev.actions?.forEach((act: any) => executeAction(act));
          }
        } else {
          triggeredEvents.delete(evKey);
        }
      });
    }, 16);

    return () => clearInterval(interval);
  }, [activeSceneId]);

  return (
    <div className="relative w-screen h-screen bg-[#050508] overflow-hidden flex items-center justify-center select-none font-sans" style={{ touchAction: 'none' }}>
      {gameData.customCSS && <style>{gameData.customCSS}</style>}
      {showRotationPrompt && (
        <div className="absolute inset-0 z-[100000] bg-black/90 flex flex-col items-center justify-center p-6 text-center text-white backdrop-blur-md">
          <svg className="w-16 h-16 mb-4 animate-bounce text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect width="18" height="12" x="3" y="6" rx="2" />
            <path d="M12 18h.01" />
          </svg>
          <h3 className="text-xl font-bold mb-2">Please Rotate Your Device</h3>
          <p className="text-sm text-gray-400">This game is best played in {aspectRatio} mode.</p>
        </div>
      )}

      {/* Screen Flash Overlay */}
      {screenFlash.active && (
        <div
          className="absolute inset-0 pointer-events-none transition-opacity duration-300 z-[99999]"
          style={{ backgroundColor: screenFlash.color, opacity: 0.75 }}
        />
      )}

      {/* ============================================================================
          ⚠️ CRITICAL PARITY WARNING ⚠️
          If you modify the rendering logic here, you MUST also make the exact same 
          change in components/GameCreatorStudio.tsx -> Preview in Realtime overlay.
          These two renderers must remain structurally identical.
          ============================================================================ */}
      {/* Full Screen Stage Wrapper */}
      <div 
        className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden touch-none"
        ref={(node) => {
          if (node) {
            const rect = node.getBoundingClientRect();
            // Scale computation exactly like Studio - use 100% of available space
            const scale = Math.min(rect.width / VIRTUAL_WIDTH, rect.height / VIRTUAL_HEIGHT);
            node.style.setProperty('--preview-scale', scale.toString());
          }
        }}
      >
        {/* Virtual Stage Container with Camera Shake */}
        <div
          id="game_stage_viewport"
          className="relative overflow-hidden shadow-2xl transition-transform duration-75 select-none"
          style={{
            width: VIRTUAL_WIDTH,
            height: VIRTUAL_HEIGHT,
            transform: `scale(var(--preview-scale, 1)) translate(${shakeOffset.x}px, ${shakeOffset.y}px)`,
            transformOrigin: 'center center',
            backgroundColor: gameData.stageBgColor || '#111111',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none'
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          {/* 1. WORLD LAYER: Camera zoom & panning applied ONLY here */}
          <div 
            id="world_camera_layer"
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{
              transform: `scale(${globalCamera.zoom || 1}) translate(${globalCamera.x || 0}px, ${globalCamera.y || 0}px)`,
              transformOrigin: 'center center',
              transition: 'transform 0.1s cubic-bezier(0.25, 1, 0.5, 1)'
            }}
          >
            {stageElements.filter(el => el.type !== 'btn' && el.type !== 'joystick').map((el, i) => {
              const gameObject = (el.type === 'obj' || el.type === 'enemy') ? (gameData.gameObjects || []).find((o: any) => o.id === el.data) : null;
              const activeAnimIndex = el.activeAnimationIndex || 0;
              const firstAnim = gameObject?.animations?.[activeAnimIndex] || gameObject?.animations?.[0];
              const isFitVideo = el.type === 'video' && el.fitToScreen;
              
              const finalZ = computeElementZIndex(el, gameData.layers || [], { gameObject });

              const isVibrating = el.vibrating;
              const vibrateClass = isVibrating ? (isVibrating === 'once' ? 'animate-[vibrate_0.3s_linear]' : 'animate-[vibrate_0.1s_linear_infinite]') : '';
              const destroyClass = el.isDestroying ? (el.destroyEffect === 'dust' ? 'opacity-0 scale-50 blur-md transition-all duration-1000' : 'opacity-0 transition-opacity duration-1000') : '';
              const filterStyle = el.glowColor ? `drop-shadow(0 0 15px ${el.glowColor})` : (el.colorFilter ? `hue-rotate(90deg) drop-shadow(0 0 8px ${el.colorFilter})` : undefined);

              let elemSrc = el.url || el.data || '';
              const isShape = elemSrc === 'rect' || elemSrc === 'circle';
              const finalBgImage = (el.type !== 'obj' && el.type !== 'video' && elemSrc && !isShape) ? `url("${elemSrc}")` : undefined;

              const resolvedVideoSrc = el.type === 'video' ? resolveVideoUrl(el.videoId || elemSrc) : '';
              const isFlippedX = Boolean(el.flipX) || (el.scaleX !== undefined && el.scaleX < 0);
              const isFlippedY = Boolean(el.flipY) || (el.scaleY !== undefined && el.scaleY < 0);
              const elementTransform = [
                el.rotation ? `rotate(${el.rotation}deg)` : '',
                isFlippedX ? 'scaleX(-1)' : '',
                isFlippedY ? 'scaleY(-1)' : '',
                el.scale && el.scale !== 1 ? `scale(${el.scale})` : ''
              ].filter(Boolean).join(' ') || undefined;

              return (
                <div
                  key={el.id}
                  data-element-id={el.id}
                  data-element-data={el.data}
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                  className={`absolute select-none ${vibrateClass} ${destroyClass} ${elemSrc === 'circle' ? 'rounded-full' : ''}`}
                  style={{
                    left: (el.type === 'bg' || isFitVideo) && !el.x ? 0 : el.x,
                    top: (el.type === 'bg' || isFitVideo) && !el.y ? 0 : el.y,
                    width: (el.type === 'bg' || isFitVideo) && !el.width ? '100%' : (el.width ? `${el.width}px` : '100%'),
                    height: (el.type === 'bg' || isFitVideo) && !el.height ? '100%' : (el.height ? `${el.height}px` : '100%'),
                    backgroundImage: finalBgImage,
                    backgroundSize: el.type === 'bg' ? 'cover' : '100% 100%',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                    zIndex: (el.type === 'bg') ? 0 : (isFitVideo ? Math.max(50000, finalZ) : finalZ),
                    opacity: el.opacity !== undefined ? el.opacity : 1,
                    transform: elementTransform,
                    filter: filterStyle,
                    pointerEvents: (el.type === 'obj' || el.type === 'enemy') ? 'auto' : 'none',
                    touchAction: 'none',
                    userSelect: 'none',
                    WebkitUserSelect: 'none'
                  }}
                  onClick={(e) => {
                    if (isSwipingActiveRef.current) {
                      e.stopPropagation();
                      e.preventDefault();
                      return;
                    }
                    if (el.type === 'obj' || el.type === 'enemy') {
                      e.stopPropagation();
                      handleElementClick(el.id);
                    }
                  }}
                >
                  {el.type === 'obj' && (gameObject?.type === 'text' || gameObject?.type === 'var_text') && (
                    <div
                      className="w-full h-full flex items-center justify-center text-center font-bold"
                      style={{
                        fontSize: `${gameObject.fontSize ?? 24}px`,
                        color: gameObject.color ?? '#ffffff',
                        fontFamily: gameObject.fontFamily ?? 'Inter, sans-serif',
                        lineHeight: 1.2,
                        wordBreak: 'break-word',
                        overflow: 'visible'
                      }}
                    >
                      {gameObject?.type === 'var_text'
                        ? String(variables.find((v) => v.id === (gameObject as any).variableId)?.value ?? '0')
                        : (gameObject.textContent ?? gameObject.name ?? 'Text')}
                    </div>
                  )}

                  {el.type === 'obj' && firstAnim?.frames?.length > 0 && (
                    <AnimatedSprite
                      frames={firstAnim.frames}
                      fps={firstAnim.fps || 24}
                      speed={(firstAnim.speed || 1) * (el.animationSpeedMultiplier || 1)}
                      tintColor={el.customColor}
                      width={el.width}
                      height={el.height}
                    />
                  )}

                  {el.isToast && (
                    <div 
                      className={`w-full h-full rounded px-3 py-1 shadow-lg text-center animate-bounce flex items-center justify-center ${
                        (el as any).style?.background === 'transparent' ? 'bg-transparent border-transparent' : 'bg-black/95 border border-yellow-500/80'
                      }`}
                      style={{
                        color: (el as any).style?.color || '#ffff00',
                        fontSize: (el as any).style?.fontSize || '20px',
                        fontFamily: (el as any).style?.fontFamily || 'monospace',
                        fontWeight: (el as any).style?.fontWeight || 'bold',
                        fontStyle: (el as any).style?.fontStyle || 'normal',
                      }}
                    >
                      {el.text}
                    </div>
                  )}

                  {el.type === 'video' && (
                    <video
                      id={`video_player_${el.id}`}
                      src={resolvedVideoSrc}
                      className="w-full h-full"
                      style={{ objectFit: el.fitToScreen ? 'cover' : 'contain', pointerEvents: 'none' }}
                      playsInline
                      webkit-playsinline="true"
                      preload="auto"
                      autoPlay
                      muted={el.muted ?? false}
                      loop={el.loop ?? false}
                      onEnded={() => {
                        handleVideoEnded(el.videoId, el.id);
                        if (!el.loop && !el.keepOnStage) {
                          setStageElements(prev => prev.filter(item => item.id !== el.id));
                        }
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* 2. UI / HUD LAYER: Fixed to screen, completely unaffected by camera */}
          <div 
            id="hud_ui_layer"
            className="absolute inset-0 w-full h-full pointer-events-none z-[60000]"
          >
            {stageElements.filter(el => el.type === 'btn' || el.type === 'joystick').map((el, i) => {
              const finalZ = computeElementZIndex(el, gameData.layers || [], {});

              const isVibrating = el.vibrating;
              const vibrateClass = isVibrating ? (isVibrating === 'once' ? 'animate-[vibrate_0.3s_linear]' : 'animate-[vibrate_0.1s_linear_infinite]') : '';
              const filterStyle = el.glowColor ? `drop-shadow(0 0 15px ${el.glowColor})` : (el.colorFilter ? `hue-rotate(90deg) drop-shadow(0 0 8px ${el.colorFilter})` : undefined);

              const btnTemplate = (el.type === 'btn' && el.buttonId) ? (gameData.uiButtons || []).find((b: any) => b.id === el.buttonId) : null;
              let elemSrc = el.url || el.data || btnTemplate?.url || btnTemplate?.data || '';
              
              const isShape = elemSrc === 'rect' || elemSrc === 'circle';
              const finalBgImage = (elemSrc && !isShape) ? `url("${elemSrc}")` : undefined;
              const finalBgColor = (!elemSrc || isShape) && el.type === 'btn' ? (el.customColor || 'rgba(236,72,153,0.2)') : undefined;

              const isFlippedX = Boolean(el.flipX) || (el.scaleX !== undefined && el.scaleX < 0);
              const isFlippedY = Boolean(el.flipY) || (el.scaleY !== undefined && el.scaleY < 0);
              const elementTransform = [
                el.rotation ? `rotate(${el.rotation}deg)` : '',
                isFlippedX ? 'scaleX(-1)' : '',
                isFlippedY ? 'scaleY(-1)' : '',
                el.scale && el.scale !== 1 ? `scale(${el.scale})` : ''
              ].filter(Boolean).join(' ') || undefined;

              return (
                <div
                  key={el.id}
                  data-element-id={el.id}
                  data-btn-id={(el as any).buttonId}
                  draggable={false}
                  className={`absolute select-none ${vibrateClass} ${elemSrc === 'circle' ? 'rounded-full' : ''}`}
                  style={{
                    left: el.x,
                    top: el.y,
                    width: el.width ? `${el.width}px` : '100px',
                    height: el.height ? `${el.height}px` : '100px',
                    backgroundImage: finalBgImage,
                    backgroundSize: '100% 100%',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                    backgroundColor: finalBgColor,
                    zIndex: finalZ,
                    cursor: el.type === 'btn' ? 'pointer' : 'default',
                    opacity: el.opacity !== undefined ? el.opacity : 1,
                    transform: elementTransform,
                    filter: filterStyle,
                    pointerEvents: 'auto',
                    touchAction: 'none',
                    userSelect: 'none',
                    WebkitUserSelect: 'none'
                  }}
                  onClick={(e) => {
                    if (isSwipingActiveRef.current) {
                      e.stopPropagation();
                      e.preventDefault();
                      return;
                    }
                    if (el.type === 'btn') {
                      e.stopPropagation();
                      handleElementClick(el.id);
                    }
                  }}
                >
                  {el.type === 'joystick' && (
                    <div 
                      className="w-full h-full rounded-full flex flex-col items-center justify-center overflow-hidden shadow-2xl relative select-none touch-none" 
                      style={{ 
                        visibility: el.hidden ? 'hidden' : 'visible', 
                        pointerEvents: 'auto',
                        backgroundColor: el.customColor ? (el.customColor + '22') : 'rgba(15, 23, 42, 0.8)',
                        border: '2px solid ' + (el.customColor || '#3b82f6'),
                        boxShadow: '0 0 16px ' + (el.customColor || '#3b82f6') + '55'
                      }}
                      onPointerDown={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const cx = rect.left + rect.width / 2;
                        const cy = rect.top + rect.height / 2;
                        const maxDist = (rect.width / 2) * 0.75;
                        const updateJoystick = (ex: number, ey: number) => {
                          const dx = ex - cx;
                          const dy = ey - cy;
                          const dist = Math.min(Math.hypot(dx, dy), maxDist);
                          const angle = Math.atan2(dy, dx);
                          const normX = maxDist > 0 ? (Math.cos(angle) * dist) / maxDist : 0;
                          const normY = maxDist > 0 ? (Math.sin(angle) * dist) / maxDist : 0;
                          const st = { active: true, x: normX, y: normY, normX, normY, angle: angle * 180 / Math.PI, distance: maxDist > 0 ? dist / maxDist : 0 };
                          setJoystickStates(prev => ({ ...prev, [el.id]: st }));
                          joystickStatesRef.current[el.id] = st;
                        };
                        updateJoystick(e.clientX, e.clientY);
                        
                        const onMove = (ev: PointerEvent) => updateJoystick(ev.clientX, ev.clientY);
                        const onUp = () => {
                          const idle = { active: false, x: 0, y: 0, normX: 0, normY: 0, angle: 0, distance: 0 };
                          setJoystickStates(prev => ({ ...prev, [el.id]: idle }));
                          joystickStatesRef.current[el.id] = idle;
                          window.removeEventListener('pointermove', onMove);
                          window.removeEventListener('pointerup', onUp);
                        };
                        window.addEventListener('pointermove', onMove);
                        window.addEventListener('pointerup', onUp);
                      }}
                    >
                      {el.url ? (
                        <img src={el.url} className="w-full h-full object-cover opacity-80 pointer-events-none" draggable={false} />
                      ) : (
                        <div className="absolute inset-2 rounded-full border border-white/10 pointer-events-none flex items-center justify-center">
                          <div className="w-2 h-2 rounded-full bg-white/30" />
                        </div>
                      )}
                      <div 
                        className="absolute rounded-full shadow-lg pointer-events-none flex items-center justify-center" 
                        style={{
                          width: '45%',
                          height: '45%',
                          backgroundColor: el.knobColor || '#60a5fa',
                          border: '2px solid ' + (el.customColor || '#93c5fd'),
                          boxShadow: '0 0 12px ' + (el.knobColor || '#60a5fa') + '99, inset 0 1px 3px rgba(255,255,255,0.6)',
                          transform: 'translate(' + ((joystickStates[el.id]?.x || 0) * 35) + 'px, ' + ((joystickStates[el.id]?.y || 0) * 35) + 'px)'
                        }}
                      >
                        <div className="w-2.5 h-2.5 rounded-full bg-white/50" />
                      </div>
                    </div>
                  )}
                  {el.type === 'btn' && (
                    <button className="w-full h-full flex items-center justify-center bg-transparent border-0 text-white font-bold cursor-pointer select-none">
                      {el.text || ''}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

        {/* Floating Text Popups */}
        {floatingTexts.map(f => (
          <div
            key={f.id}
            className="absolute pointer-events-none font-extrabold animate-float-up z-[9999]"
            style={{
              left: f.x,
              top: f.y - 40,
              transform: 'translate(-50%, -50%)',
              color: f.color,
              fontSize: `${f.fontSize}px`,
              textShadow: '0 2px 8px rgba(0,0,0,0.8)'
            }}
          >
            {f.text}
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}

// --- Root Entry Point with Splash Autoplay Unlock ---
export default function App() {
  const [hasStarted, setHasStarted] = useState(false);

  return (
    <div className="w-screen h-screen bg-black overflow-hidden flex items-center justify-center">
      {!hasStarted ? (
        <div
          onClick={() => {
            getSharedAudioContext();
            setHasStarted(true);
          }}
          className="absolute inset-0 z-[9999] flex flex-col items-center justify-center bg-[#09090b] text-white cursor-pointer select-none transition-opacity duration-300 p-6"
        >
          <div className="w-20 h-20 rounded-full bg-white text-black flex items-center justify-center mb-6 shadow-2xl hover:scale-105 active:scale-95 transition-transform duration-200">
            <svg className="w-10 h-10 ml-1 fill-current" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">new-animation-2</h1>
          <p className="text-sm text-gray-400">Click or tap anywhere to start playing</p>
        </div>
      ) : (
        <ActiveGame />
      )}
    </div>
  );
}
