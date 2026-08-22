import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Camera, Crosshair, Radio, Navigation, Layers2, Orbit, Sparkles, Shield, Gamepad2, Flame, Zap, Skull, Star, Swords, Crown, Timer, Triangle, Sun, CloudFog } from 'lucide-react';
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
  const allSceneEls = (elements || []).filter(el => el && !el.hidden && (el.type === 'bg' || el.type === 'env_tile' || el.type === 'env_hazard' || el.type === 'env_weather' || el.type === 'env_light' || el.type === 'obj'));
  
  if (allSceneEls.length === 0) {
    return { x: camX, y: camY };
  }
  
  let minX = 0, minY = 0, maxX = vWidth, maxY = vHeight;
  for (const el of allSceneEls) {
     const ex = Number(el.x || 0);
     const ey = Number(el.y || 0);
     const ew = Number(el.width || (el.type === 'bg' ? vWidth : 50)) * Number(el.scale || 1);
     const eh = Number(el.height || (el.type === 'bg' ? vHeight : 50)) * Number(el.scale || 1);
     if (ex < minX) minX = ex;
     if (ey < minY) minY = ey;
     if (ex + ew > maxX) maxX = ex + ew;
     if (ey + eh > maxY) maxY = ey + eh;
  }
  
  const marginX = Math.max(vWidth * 0.6, 350);
  const marginY = Math.max(vHeight * 0.6, 250);
  const worldMinX = minX - marginX;
  const worldMaxX = maxX + marginX;
  const worldMinY = minY - marginY;
  const worldMaxY = maxY + marginY;

  const currentZoom = Math.max(0.1, zoom || 1);
  const halfViewW = (vWidth / 2) / currentZoom;
  const halfViewH = (vHeight / 2) / currentZoom;

  const minCenterWorldX = worldMinX + halfViewW;
  const maxCenterWorldX = worldMaxX - halfViewW;
  const minCenterWorldY = worldMinY + halfViewH;
  const maxCenterWorldY = worldMaxY - halfViewH;

  let currentWorldCenterX = vWidth / 2 - camX;
  let currentWorldCenterY = vHeight / 2 - camY;

  if (minCenterWorldX <= maxCenterWorldX) {
    currentWorldCenterX = Math.max(minCenterWorldX, Math.min(maxCenterWorldX, currentWorldCenterX));
  }
  if (minCenterWorldY <= maxCenterWorldY) {
    currentWorldCenterY = Math.max(minCenterWorldY, Math.min(maxCenterWorldY, currentWorldCenterY));
  }

  return {
    x: vWidth / 2 - currentWorldCenterX,
    y: vHeight / 2 - currentWorldCenterY
  };
}

function VirtualJoystickRenderer({
  id,
  type = 'movement',
  name,
  design = 'classic-ring',
  color = '#3b82f6',
  knobColor = '#60a5fa',
  url,
  state,
  onPointerDown,
  width = 100,
  height = 100,
  interactive = true
}: any) {
  const isCamera = type === 'camera';
  const effectiveBaseColor = color || (isCamera ? '#eab308' : '#3b82f6');
  const effectiveKnobColor = knobColor || (isCamera ? '#fde047' : '#60a5fa');
  const knobX = state?.knobX || 0;
  const knobY = state?.knobY || 0;
  const isActive = state?.active || false;
  const normalizedDesign = (design === 'gimbal-compass' ? 'compass-gimbal' : design);
  const currentDesign = normalizedDesign || (url ? 'custom-image' : 'classic-ring');
  const knobSize = Math.round(width * 0.44);

  const renderClassicRingBase = () => (
    <div
      className="absolute inset-0 rounded-full pointer-events-none"
      style={{
        backgroundColor: isCamera ? 'rgba(22, 18, 8, 0.85)' : 'rgba(10, 16, 28, 0.85)',
        border: '2px solid ' + effectiveBaseColor + '88',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div
        className="absolute inset-1.5 rounded-full pointer-events-none opacity-40"
        style={{
          border: '1.5px dashed ' + effectiveBaseColor,
        }}
      />
      {isCamera ? (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="absolute top-1.5 left-1.5 w-2 h-2 border-t-2 border-l-2" style={{ borderColor: effectiveBaseColor }} />
          <div className="absolute top-1.5 right-1.5 w-2 h-2 border-t-2 border-r-2" style={{ borderColor: effectiveBaseColor }} />
          <div className="absolute bottom-1.5 left-1.5 w-2 h-2 border-b-2 border-l-2" style={{ borderColor: effectiveBaseColor }} />
          <div className="absolute bottom-1.5 right-1.5 w-2 h-2 border-b-2 border-r-2" style={{ borderColor: effectiveBaseColor }} />
          <div className="absolute w-full h-[1px] opacity-20" style={{ backgroundColor: effectiveBaseColor }} />
          <div className="absolute h-full w-[1px] opacity-20" style={{ backgroundColor: effectiveBaseColor }} />
        </div>
      ) : (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="absolute top-1.5 text-[8px] font-black opacity-60" style={{ color: effectiveBaseColor }}>▲</div>
          <div className="absolute bottom-1.5 text-[8px] font-black opacity-60" style={{ color: effectiveBaseColor }}>▼</div>
          <div className="absolute left-1.5 text-[8px] font-black opacity-60" style={{ color: effectiveBaseColor }}>◀</div>
          <div className="absolute right-1.5 text-[8px] font-black opacity-60" style={{ color: effectiveBaseColor }}>▶</div>
        </div>
      )}
    </div>
  );

  const renderDesignBase = () => {
    switch (currentDesign) {
      case 'custom-image':
        if (url) {
          return (
            <div className="absolute inset-0 rounded-full overflow-hidden pointer-events-none">
              <img src={url} alt={name || 'Joystick'} className="w-full h-full object-cover opacity-85" draggable={false} />
              <div className="absolute inset-0 rounded-full border-2" style={{ borderColor: effectiveBaseColor + '88' }} />
            </div>
          );
        }
        return renderClassicRingBase();

      case 'dpad-arrows':
        return (
          <div className="absolute inset-0 rounded-full pointer-events-none flex items-center justify-center">
            <svg viewBox="0 0 100 100" className="w-full h-full absolute inset-0">
              <circle cx="50" cy="50" r="47" fill="rgba(8, 12, 20, 0.85)" stroke={effectiveBaseColor + '77'} strokeWidth="2" />
              <polygon points="50,10 44,18 56,18" fill={effectiveBaseColor} opacity="0.85" />
              <polygon points="50,90 44,82 56,82" fill={effectiveBaseColor} opacity="0.85" />
              <polygon points="10,50 18,44 18,56" fill={effectiveBaseColor} opacity="0.85" />
              <polygon points="90,50 82,44 82,56" fill={effectiveBaseColor} opacity="0.85" />
              <line x1="26" y1="50" x2="74" y2="50" stroke={effectiveBaseColor + '33'} strokeWidth="1.5" strokeDasharray="3 3" />
              <line x1="50" y1="26" x2="50" y2="74" stroke={effectiveBaseColor + '33'} strokeWidth="1.5" strokeDasharray="3 3" />
              <circle cx="50" cy="50" r="28" fill="none" stroke={effectiveBaseColor + '44'} strokeWidth="1" />
              <circle cx="28" cy="28" r="2" fill={effectiveBaseColor + '66'} />
              <circle cx="72" cy="28" r="2" fill={effectiveBaseColor + '66'} />
              <circle cx="28" cy="72" r="2" fill={effectiveBaseColor + '66'} />
              <circle cx="72" cy="72" r="2" fill={effectiveBaseColor + '66'} />
            </svg>
          </div>
        );

      case 'neon-glow':
        return (
          <div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              backgroundColor: 'rgba(5, 7, 15, 0.9)',
              border: '2px solid ' + effectiveBaseColor,
              boxShadow: '0 0 18px ' + effectiveBaseColor + '99, inset 0 0 14px ' + effectiveBaseColor + '44',
            }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full absolute inset-0">
              <circle cx="50" cy="50" r="40" fill="none" stroke={effectiveBaseColor} strokeWidth="1" strokeDasharray="4 4" opacity="0.6" />
              <circle cx="50" cy="50" r="26" fill="none" stroke={effectiveBaseColor} strokeWidth="1.5" opacity="0.8" />
              <line x1="50" y1="4" x2="50" y2="12" stroke={effectiveBaseColor} strokeWidth="2" />
              <line x1="50" y1="88" x2="50" y2="96" stroke={effectiveBaseColor} strokeWidth="2" />
              <line x1="4" y1="50" x2="12" y2="50" stroke={effectiveBaseColor} strokeWidth="2" />
              <line x1="88" y1="50" x2="96" y2="50" stroke={effectiveBaseColor} strokeWidth="2" />
            </svg>
          </div>
        );

      case 'minimal-dot':
        return (
          <div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              backgroundColor: effectiveBaseColor + '0d',
              backdropFilter: 'blur(10px)',
              border: '1px solid ' + effectiveBaseColor + '40',
            }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full absolute inset-0">
              <circle cx="50" cy="50" r="36" fill="none" stroke={effectiveBaseColor + '25'} strokeWidth="1" />
              <circle cx="50" cy="12" r="1.5" fill={effectiveBaseColor} opacity="0.6" />
              <circle cx="50" cy="88" r="1.5" fill={effectiveBaseColor} opacity="0.6" />
              <circle cx="12" cy="50" r="1.5" fill={effectiveBaseColor} opacity="0.6" />
              <circle cx="88" cy="50" r="1.5" fill={effectiveBaseColor} opacity="0.6" />
            </svg>
          </div>
        );

      case 'hexagon-grid':
        return (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <svg viewBox="0 0 100 100" className="w-full h-full absolute inset-0">
              <polygon
                points="50,4 90,26 90,74 50,96 10,74 10,26"
                fill="rgba(8, 14, 24, 0.9)"
                stroke={effectiveBaseColor}
                strokeWidth="2"
              />
              <polygon
                points="50,20 76,34 76,66 50,80 24,66 24,34"
                fill="none"
                stroke={effectiveBaseColor + '44'}
                strokeWidth="1.2"
                strokeDasharray="3 3"
              />
              <line x1="50" y1="4" x2="50" y2="20" stroke={effectiveBaseColor} strokeWidth="1.5" opacity="0.7" />
              <line x1="90" y1="26" x2="76" y2="34" stroke={effectiveBaseColor} strokeWidth="1.5" opacity="0.7" />
              <line x1="90" y1="74" x2="76" y2="66" stroke={effectiveBaseColor} strokeWidth="1.5" opacity="0.7" />
              <line x1="50" y1="96" x2="50" y2="80" stroke={effectiveBaseColor} strokeWidth="1.5" opacity="0.7" />
              <line x1="10" y1="74" x2="24" y2="66" stroke={effectiveBaseColor} strokeWidth="1.5" opacity="0.7" />
              <line x1="10" y1="26" x2="24" y2="34" stroke={effectiveBaseColor} strokeWidth="1.5" opacity="0.7" />
              <circle cx="50" cy="4" r="2.5" fill={effectiveBaseColor} />
              <circle cx="90" cy="26" r="2.5" fill={effectiveBaseColor} />
              <circle cx="90" cy="74" r="2.5" fill={effectiveBaseColor} />
              <circle cx="50" cy="96" r="2.5" fill={effectiveBaseColor} />
              <circle cx="10" cy="74" r="2.5" fill={effectiveBaseColor} />
              <circle cx="10" cy="26" r="2.5" fill={effectiveBaseColor} />
            </svg>
          </div>
        );

      case 'compass-gimbal':
        return (
          <div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              backgroundColor: isCamera ? 'rgba(24, 18, 8, 0.88)' : 'rgba(8, 16, 28, 0.88)',
              border: '2px solid ' + effectiveBaseColor + '99',
              boxShadow: '0 0 12px ' + effectiveBaseColor + '33',
            }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full absolute inset-0">
              <circle cx="50" cy="50" r="44" fill="none" stroke={effectiveBaseColor + '44'} strokeWidth="1" />
              <circle cx="50" cy="50" r="32" fill="none" stroke={effectiveBaseColor + '33'} strokeWidth="1" strokeDasharray="2 4" />
              <line x1="12" y1="50" x2="88" y2="50" stroke={effectiveBaseColor + '44'} strokeWidth="1" />
              <line x1="50" y1="12" x2="50" y2="88" stroke={effectiveBaseColor + '44'} strokeWidth="1" />
              <text x="50" y="11" textAnchor="middle" fill={effectiveBaseColor} fontSize="7" fontWeight="bold" fontFamily="monospace">N</text>
              <text x="50" y="97" textAnchor="middle" fill={effectiveBaseColor} fontSize="7" fontWeight="bold" fontFamily="monospace">S</text>
              <text x="7" y="52.5" textAnchor="middle" fill={effectiveBaseColor} fontSize="7" fontWeight="bold" fontFamily="monospace">W</text>
              <text x="93" y="52.5" textAnchor="middle" fill={effectiveBaseColor} fontSize="7" fontWeight="bold" fontFamily="monospace">E</text>
              <line x1="22" y1="22" x2="27" y2="27" stroke={effectiveBaseColor + '66'} strokeWidth="1.2" />
              <line x1="78" y1="22" x2="73" y2="27" stroke={effectiveBaseColor + '66'} strokeWidth="1.2" />
              <line x1="22" y1="78" x2="27" y2="73" stroke={effectiveBaseColor + '66'} strokeWidth="1.2" />
              <line x1="78" y1="78" x2="73" y2="73" stroke={effectiveBaseColor + '66'} strokeWidth="1.2" />
            </svg>
          </div>
        );

      case 'retro-arcade':
        return (
          <div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              backgroundColor: 'rgba(10, 10, 14, 0.95)',
              border: '3px solid ' + effectiveBaseColor,
              boxShadow: 'inset 0 0 10px rgba(0,0,0,0.8), 0 4px 10px rgba(0,0,0,0.6)',
            }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full absolute inset-0">
              <polygon
                points="35,14 65,14 86,35 86,65 65,86 35,86 14,65 14,35"
                fill="none"
                stroke={effectiveBaseColor + '77'}
                strokeWidth="2"
              />
              <rect x="47" y="5" width="6" height="6" fill={effectiveBaseColor} />
              <rect x="47" y="89" width="6" height="6" fill={effectiveBaseColor} />
              <rect x="5" y="47" width="6" height="6" fill={effectiveBaseColor} />
              <rect x="89" y="47" width="6" height="6" fill={effectiveBaseColor} />
            </svg>
          </div>
        );

      case 'glass-frosted':
        return (
          <div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.03) 100%)',
              backdropFilter: 'blur(16px)',
              border: '1.5px solid rgba(255, 255, 255, 0.4)',
              boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37), inset 0 1px 1px 0 rgba(255, 255, 255, 0.6), inset 0 -2px 6px ' + effectiveBaseColor + '55',
            }}
          >
            <div
              className="absolute inset-2 rounded-full border border-dashed opacity-40 pointer-events-none"
              style={{ borderColor: effectiveBaseColor }}
            />
          </div>
        );

      case 'outline-only':
        return (
          <div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              backgroundColor: 'transparent',
              border: '1.5px solid ' + effectiveBaseColor,
            }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full absolute inset-0">
              <circle cx="50" cy="50" r="38" fill="none" stroke={effectiveBaseColor + '66'} strokeWidth="1" strokeDasharray="3 2" />
              <circle cx="50" cy="50" r="20" fill="none" stroke={effectiveBaseColor + '44'} strokeWidth="0.75" />
              <line x1="50" y1="2" x2="50" y2="98" stroke={effectiveBaseColor + '33'} strokeWidth="0.75" />
              <line x1="2" y1="50" x2="98" y2="50" stroke={effectiveBaseColor + '33'} strokeWidth="0.75" />
            </svg>
          </div>
        );

      case 'gradient-orb':
        return (
          <div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              background: 'radial-gradient(circle at 40% 40%, ' + effectiveBaseColor + '33 0%, rgba(10, 12, 22, 0.9) 75%)',
              border: '1.5px solid ' + effectiveBaseColor + '77',
              boxShadow: '0 0 20px ' + effectiveBaseColor + '44',
            }}
          >
            <div className="absolute inset-1.5 rounded-full border border-white/10 pointer-events-none" />
          </div>
        );

      case 'classic-ring':
      default:
        return renderClassicRingBase();
    }
  };

  const renderKnob = () => {
    switch (currentDesign) {
      case 'dpad-arrows':
        return (
          <div
            className="w-full h-full rounded-full flex items-center justify-center shadow-2xl relative overflow-hidden"
            style={{
              background: 'radial-gradient(circle at 35% 35%, ' + effectiveKnobColor + ', ' + effectiveBaseColor + ' 75%, #050810 100%)',
              border: '2px solid ' + effectiveKnobColor,
              boxShadow: '0 0 14px ' + effectiveBaseColor + '88, inset 0 2px 4px rgba(255,255,255,0.4)',
            }}
          >
            <div className="w-1/2 h-1/2 rounded-full border border-white/40 flex items-center justify-center">
              {isCamera ? (
                <Camera size={Math.max(10, Math.round(knobSize * 0.4))} className="text-black drop-shadow" />
              ) : (
                <div className="w-2 h-2 rounded-full bg-white/60 shadow" />
              )}
            </div>
          </div>
        );

      case 'neon-glow':
        return (
          <div
            className="w-full h-full rounded-full flex items-center justify-center relative"
            style={{
              background: 'radial-gradient(circle at 35% 35%, #ffffff 0%, ' + effectiveKnobColor + ' 45%, ' + effectiveBaseColor + ' 85%, #000000 100%)',
              border: '2px solid ' + effectiveKnobColor,
              boxShadow: '0 0 22px ' + effectiveKnobColor + ', 0 0 8px #ffffff, inset 0 0 10px #ffffff',
            }}
          >
            {isCamera ? (
              <Camera size={Math.max(10, Math.round(knobSize * 0.45))} className="text-black drop-shadow" />
            ) : (
              <div className="w-2.5 h-2.5 rounded-full bg-white shadow-[0_0_8px_#ffffff]" />
            )}
          </div>
        );

      case 'minimal-dot':
        return (
          <div
            className="w-full h-full rounded-full flex items-center justify-center shadow-lg"
            style={{
              backgroundColor: 'rgba(15, 20, 30, 0.85)',
              border: '1.5px solid ' + effectiveKnobColor,
              boxShadow: '0 4px 12px rgba(0,0,0,0.5), 0 0 10px ' + effectiveKnobColor + '44',
            }}
          >
            {isCamera ? (
              <Camera size={Math.max(10, Math.round(knobSize * 0.4))} style={{ color: effectiveKnobColor }} />
            ) : (
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: effectiveKnobColor, boxShadow: '0 0 6px ' + effectiveKnobColor }} />
            )}
          </div>
        );

      case 'hexagon-grid':
        return (
          <div className="w-full h-full flex items-center justify-center relative">
            <svg viewBox="0 0 100 100" className="w-full h-full">
              <polygon
                points="50,6 88,28 88,72 50,94 12,72 12,28"
                fill={'url(#hexGrad_' + id + ')'}
                stroke={effectiveKnobColor}
                strokeWidth="4"
              />
              <defs>
                <radialGradient id={'hexGrad_' + id} cx="40%" cy="35%" r="70%">
                  <stop offset="0%" stopColor={effectiveKnobColor} />
                  <stop offset="70%" stopColor={effectiveBaseColor} />
                  <stop offset="100%" stopColor="#050810" />
                </radialGradient>
              </defs>
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              {isCamera ? (
                <Camera size={Math.max(10, Math.round(knobSize * 0.4))} className="text-black drop-shadow" />
              ) : (
                <div className="w-2 h-2 rotate-45 border-2 border-white/70" />
              )}
            </div>
          </div>
        );

      case 'compass-gimbal':
        return (
          <div
            className="w-full h-full rounded-full flex items-center justify-center shadow-xl relative"
            style={{
              background: 'radial-gradient(circle at 35% 35%, ' + effectiveKnobColor + ', ' + effectiveBaseColor + ' 70%, #080c14 100%)',
              border: '2px solid ' + effectiveKnobColor,
              boxShadow: '0 0 16px ' + effectiveKnobColor + '77, inset 0 2px 4px rgba(255,255,255,0.5)',
            }}
          >
            {isCamera ? (
              <Camera size={Math.max(10, Math.round(knobSize * 0.42))} className="text-black drop-shadow" />
            ) : (
              <Crosshair size={Math.max(10, Math.round(knobSize * 0.45))} className="text-black drop-shadow opacity-80" />
            )}
          </div>
        );

      case 'retro-arcade':
        return (
          <div
            className="w-full h-full rounded-full flex items-center justify-center shadow-2xl relative"
            style={{
              background: 'radial-gradient(circle at 30% 25%, #ffffff 0%, ' + effectiveKnobColor + ' 30%, ' + effectiveBaseColor + ' 80%, #000000 100%)',
              border: '2px solid #ffffff',
              boxShadow: '0 6px 14px rgba(0,0,0,0.8), inset 0 3px 6px rgba(255,255,255,0.7)',
            }}
          >
            {isCamera ? (
              <Camera size={Math.max(10, Math.round(knobSize * 0.4))} className="text-black drop-shadow" />
            ) : (
              <div className="w-2.5 h-2.5 rounded-full bg-white/40 border border-white/60 shadow" />
            )}
          </div>
        );

      case 'glass-frosted':
        return (
          <div
            className="w-full h-full rounded-full flex items-center justify-center relative shadow-xl overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.55) 0%, ' + effectiveKnobColor + '99 40%, ' + effectiveBaseColor + ' 100%)',
              backdropFilter: 'blur(12px)',
              border: '2px solid rgba(255,255,255,0.7)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.4), inset 0 2px 4px rgba(255,255,255,0.8), 0 0 16px ' + effectiveKnobColor + '66',
            }}
          >
            <div className="absolute top-1 left-2 right-2 h-1/3 rounded-full bg-white/40 blur-[0.5px]" />
            {isCamera ? (
              <Camera size={Math.max(10, Math.round(knobSize * 0.4))} className="text-black drop-shadow relative z-10" />
            ) : (
              <div className="w-2.5 h-2.5 rounded-full bg-white/80 shadow relative z-10" />
            )}
          </div>
        );

      case 'outline-only':
        return (
          <div
            className="w-full h-full rounded-full flex items-center justify-center relative"
            style={{
              backgroundColor: 'rgba(10, 15, 25, 0.8)',
              border: '2px solid ' + effectiveKnobColor,
              boxShadow: '0 0 10px ' + effectiveKnobColor + '55',
            }}
          >
            {isCamera ? (
              <Camera size={Math.max(10, Math.round(knobSize * 0.42))} style={{ color: effectiveKnobColor }} />
            ) : (
              <div className="w-2 h-2 rounded-full border border-current" style={{ color: effectiveKnobColor }} />
            )}
          </div>
        );

      case 'gradient-orb':
        return (
          <div
            className="w-full h-full rounded-full flex items-center justify-center shadow-2xl relative"
            style={{
              background: 'radial-gradient(circle at 28% 25%, #ffffff 0%, ' + effectiveKnobColor + ' 25%, ' + effectiveBaseColor + ' 70%, #03050c 100%)',
              border: '1.5px solid ' + effectiveKnobColor,
              boxShadow: '0 8px 20px rgba(0,0,0,0.6), 0 0 16px ' + effectiveKnobColor + '88, inset 0 2px 5px rgba(255,255,255,0.6)',
            }}
          >
            {isCamera ? (
              <Camera size={Math.max(10, Math.round(knobSize * 0.4))} className="text-black drop-shadow" />
            ) : (
              <div className="w-2 h-2 rounded-full bg-white/70 shadow" />
            )}
          </div>
        );

      case 'classic-ring':
      default:
        return (
          <div
            className="w-full h-full rounded-full flex items-center justify-center shadow-2xl relative"
            style={{
              background: 'radial-gradient(circle at 35% 35%, ' + effectiveKnobColor + ', ' + effectiveBaseColor + ' 70%, #050508 100%)',
              border: '2px solid ' + effectiveKnobColor,
              boxShadow: '0 0 16px ' + effectiveBaseColor + '99, inset 0 2px 4px rgba(255,255,255,0.5), inset 0 -2px 4px rgba(0,0,0,0.7)',
            }}
          >
            {isCamera ? (
              <Camera size={Math.max(10, Math.round(knobSize * 0.4))} className="text-black drop-shadow" />
            ) : (
              <div className="w-3 h-3 rounded-full border-2 border-white/40 opacity-70" />
            )}
          </div>
        );
    }
  };

  return (
    <div
      className={'relative select-none touch-none flex items-center justify-center transition-all ' + (isActive ? 'shadow-[0_0_30px_rgba(255,255,255,0.35)]' : 'shadow-xl')}
      style={{
        width: width + 'px',
        height: height + 'px',
        cursor: interactive ? 'grab' : 'default',
        pointerEvents: interactive ? 'auto' : 'none'
      }}
      onPointerDown={(e) => {
        if (interactive && onPointerDown) {
          onPointerDown(e, id);
        }
      }}
    >
      {renderDesignBase()}
      <div
        className={'absolute pointer-events-none transition-transform duration-75 flex items-center justify-center ' + (isActive ? 'scale-110 brightness-125' : 'scale-100')}
        style={{
          width: knobSize + 'px',
          height: knobSize + 'px',
          transform: 'translate(' + knobX + 'px, ' + knobY + 'px)'
        }}
      >
        {renderKnob()}
      </div>
    </div>
  );
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
    allEvents?: any[];
  }
): boolean => {
  if (!ev) return false;

  // If this is a sub-event (child event), parent conditions must also be satisfied
  if (ev.parentId && ctx?.allEvents) {
    const parent = ctx.allEvents.find((e: any) => e.id === ev.parentId);
    if (parent) {
      if (!evaluateEventConditions(parent, triggerContext, parent.id, ctx)) {
        return false;
      }
    }
  }

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

// --- Standalone Game Map Renderer ---
function GameMapRenderer({ config, mapConfig: propMapConfig, stageElements = [], gameObjects = [], joystickStates, virtualWidth = 800, virtualHeight = 450 }: any) {
  const mapConfig = config || propMapConfig || {
    id: 'default_map',
    name: 'Radar',
    type: 'radar_circle',
    width: 170,
    height: 170,
    zoom: 0.25,
    radarColor: '#22c55e',
    playerBlipColor: '#22c55e',
    enemyBlipColor: '#ef4444',
    neutralBlipColor: '#eab308',
    showTrackingLine: true,
    trackingLineColor: '#ef4444',
    showDistanceText: true,
    distanceUnit: 'm',
    showGrid: true,
    radarSweep: true,
    label: 'RADAR SCAN'
  };
  const width = mapConfig.width || 170;
  const height = mapConfig.height || 170;
  const cx = width / 2;
  const cy = height / 2;

  // Keep track of the last moved character
  const lastMovedIdRef = useRef<string | null>(null);

  // Find currently moved character by joystick
  let currentlyMovedId: string | null = null;
  let currentlyMovedRotation = 0;

  if (joystickStates) {
    const activeJoyId = Object.keys(joystickStates).find(id => joystickStates[id]?.active && joystickStates[id]?.distance > 0.05);
    if (activeJoyId) {
      const joyState = joystickStates[activeJoyId];
      const joyEl = stageElements.find((el: any) => el.id === activeJoyId);
      if (joyEl) {
        const attachedId = joyEl.attachedObjectId || joyEl.joystickConfig?.attachedObjectId;
        if (attachedId) {
           const attachedObj = stageElements.find((el: any) => el.id === attachedId || el.data === attachedId);
           if (attachedObj) {
             currentlyMovedId = attachedObj.id;
             currentlyMovedRotation = joyState.angle;
           }
        } else {
           const defaultTarget = stageElements.find((el: any) => (el.type === 'obj' || el.type === 'character') && !el.hidden);
           if (defaultTarget) {
             currentlyMovedId = defaultTarget.id;
             currentlyMovedRotation = joyState.angle;
           }
        }
      }
    }
  }

  if (currentlyMovedId) {
    lastMovedIdRef.current = currentlyMovedId;
  }

  const { sourceEl, mainCharRotation } = useMemo(() => {
    let activeSource = null;
    let rotation = 0;

    // 1. If currently moved, use it!
    if (currentlyMovedId) {
      const match = stageElements.find((el: any) => el.id === currentlyMovedId);
      if (match) {
        activeSource = match;
        rotation = currentlyMovedRotation;
      }
    }

    // 2. If not currently moved, but we have a last moved id, use that!
    if (!activeSource && lastMovedIdRef.current) {
      const match = stageElements.find((el: any) => el.id === lastMovedIdRef.current);
      if (match) {
        activeSource = match;
        rotation = match.rotation || 0;
      }
    }

    // 3. Fallback to trackerSource
    if (!activeSource && mapConfig.trackerSource) {
      const match = stageElements.find((el: any) => el.id === mapConfig.trackerSource || el.data === mapConfig.trackerSource);
      if (match) {
        activeSource = match;
        rotation = match.rotation || 0;
      }
    }

    // 4. Fallback: auto-detect first player / character object
    if (!activeSource) {
      const playerObj = stageElements.find((el: any) => el.type === 'obj' && (
        (el.name || '').toString().toLowerCase().includes('player') ||
        (el.name || '').toString().toLowerCase().includes('hero') ||
        (typeof el.data === 'string' ? el.data : '').toLowerCase().includes('player')
      ));
      if (playerObj) {
        activeSource = playerObj;
        rotation = playerObj.rotation || 0;
      }
    }

    // 5. Absolute fallback
    if (!activeSource) {
      activeSource = stageElements.find((el: any) => el.type === 'obj') || { x: virtualWidth / 2, y: virtualHeight / 2, width: 50, height: 50, rotation: 0 };
      rotation = activeSource.rotation || 0;
    }

    return { sourceEl: activeSource, mainCharRotation: rotation };
  }, [stageElements, currentlyMovedId, currentlyMovedRotation, mapConfig.trackerSource, virtualWidth, virtualHeight]);

  const sourcePos = {
    x: (sourceEl.x || 0) + ((sourceEl.width || 50) / 2),
    y: (sourceEl.y || 0) + ((sourceEl.height || 50) / 2)
  };

  const { enemyBlips, otherBlips, closestEnemy, explicitTargets } = useMemo(() => {
    const enemies: any[] = [];
    const others: any[] = [];
    let closest: any = null;
    let minDistance = Infinity;

    stageElements.forEach((el: any) => {
      if (!el || el.id === sourceEl.id || el.hidden || el.type === 'bg' || el.type === 'game_map' || el.type === 'game_loading' || el.type === 'btn' || el.type === 'joystick' || el.type === 'virtual_joystick' || el.type === 'text') return;

      const ex = (el.x || 0) + ((el.width || 50) / 2);
      const ey = (el.y || 0) + ((el.height || 50) / 2);
      const dx = ex - sourcePos.x;
      const dy = ey - sourcePos.y;
      const distPx = Math.hypot(dx, dy);
      const distM = Math.max(1, Math.round(distPx / 5));

      const zoom = mapConfig.zoom || 0.25;
      const maxRadius = Math.min(cx, cy) - 14;
      const rawRelX = dx * zoom;
      const rawRelY = dy * zoom;
      const rawDist = Math.hypot(rawRelX, rawRelY);

      let blipX = cx + rawRelX;
      let blipY = cy + rawRelY;
      let isClamped = false;

      if (mapConfig.type === 'radar_circle' || mapConfig.type === 'compass_dial') {
        if (rawDist > maxRadius) {
          const angle = Math.atan2(rawRelY, rawRelX);
          blipX = cx + Math.cos(angle) * maxRadius;
          blipY = cy + Math.sin(angle) * maxRadius;
          isClamped = true;
        }
      } else {
        blipX = Math.max(10, Math.min(width - 10, blipX));
        blipY = Math.max(10, Math.min(height - 10, blipY));
      }

      const isEnemy =
        el.type === 'env_hazard' ||
        (el.name || '').toString().toLowerCase().includes('enemy') ||
        (el.name || '').toString().toLowerCase().includes('boss') ||
        (el.name || '').toString().toLowerCase().includes('monster') ||
        (el.name || '').toString().toLowerCase().includes('hazard') ||
        (el.name || '').toString().toLowerCase().includes('ghost') ||
        (el.name || '').toString().toLowerCase().includes('skull') ||
        (el.name || '').toString().toLowerCase().includes('alien') ||
        (typeof el.data === 'string' ? el.data : '').toLowerCase().includes('enemy');

      // Filter by trackedTargetIds if they exist
      const isExplicitlyTracked = mapConfig.trackedTargetIds?.includes(el.id);

      const blipData = {
        id: el.id,
        name: el.name || 'Target',
        x: blipX,
        y: blipY,
        worldX: el.x || 0,
        worldY: el.y || 0,
        distPx,
        distM,
        isEnemy: isEnemy || isExplicitlyTracked,
        isClamped
      };

      if (blipData.isEnemy) {
        enemies.push(blipData);
        if (distPx < minDistance) {
          minDistance = distPx;
          closest = blipData;
        }
      } else {
        others.push(blipData);
      }
    });

    if (mapConfig.targetEnemyId) {
      const explicit = enemies.find((e: any) => e.id === mapConfig.targetEnemyId) || others.find((o: any) => o.id === mapConfig.targetEnemyId);
      if (explicit) closest = explicit;
    }

    return { 
      enemyBlips: enemies, 
      otherBlips: others, 
      closestEnemy: closest || enemies[0],
      explicitTargets: enemies.filter((e: any) => mapConfig.trackedTargetIds?.includes(e.id))
    };
  }, [stageElements, sourceEl, sourcePos, mapConfig, cx, cy, width, height]);

  const radarColor = mapConfig.radarColor || '#22c55e';
  const playerColor = mapConfig.playerBlipColor || '#22c55e';
  const enemyColor = mapConfig.enemyBlipColor || '#ef4444';
  const lineColor = mapConfig.trackingLineColor || '#ef4444';
  const neutralColor = mapConfig.neutralBlipColor || '#eab308';
  const isCircular = mapConfig.type === 'radar_circle' || mapConfig.type === 'compass_dial';

  const targetsForLines = useMemo(() => {
    if (explicitTargets.length > 0) return explicitTargets;
    if (closestEnemy) return [closestEnemy];
    return [];
  }, [explicitTargets, closestEnemy]);

  return (
    <div
      className={`relative overflow-hidden pointer-events-none select-none transition-all shadow-2xl ${isCircular ? 'rounded-full' : 'rounded-2xl'}`}
      style={{
        width,
        height,
        backgroundColor:
          mapConfig.type === 'fantasy_parchment'
            ? 'rgba(41, 27, 15, 0.95)'
            : mapConfig.type === 'tactical_grid'
            ? 'rgba(6, 18, 28, 0.92)'
            : 'rgba(9, 11, 16, 0.88)',
        border: `2px solid ${radarColor}`,
        boxShadow: `0 0 20px ${radarColor}33`,
        opacity: mapConfig.opacity ?? 0.9
      }}
    >
      {mapConfig.showGrid && (
        <div className="absolute inset-0 bg-[radial-gradient(#ffffff18_1px,transparent_1px)] [background-size:16px_16px] pointer-events-none" />
      )}
      {isCircular && (
        <>
          <div className="absolute inset-0 m-auto w-3/4 h-3/4 rounded-full border border-white/10 pointer-events-none" />
          <div className="absolute inset-0 m-auto w-1/2 h-1/2 rounded-full border border-white/15 pointer-events-none" />
          <div className="absolute inset-0 m-auto w-1/4 h-1/4 rounded-full border border-white/20 pointer-events-none" />
          <div className="absolute inset-0 m-auto w-full h-[1px] bg-white/10 pointer-events-none" />
          <div className="absolute inset-0 m-auto h-full w-[1px] bg-white/10 pointer-events-none" />
        </>
      )}
      {mapConfig.type === 'tactical_grid' && (
        <div className="absolute inset-0 border border-cyan-500/20 bg-[linear-gradient(to_right,#06b6d415_1px,transparent_1px),linear-gradient(to_bottom,#06b6d415_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none" />
      )}
      {mapConfig.radarSweep && (
        <div
          className="absolute inset-0 origin-center animate-spin pointer-events-none"
          style={{
            animationDuration: '3.5s',
            background: `conic-gradient(from 0deg, transparent 270deg, ${radarColor}44 360deg)`
          }}
        />
      )}
      {mapConfig.showTrackingLine && targetsForLines.length > 0 && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          {targetsForLines.map((target) => (
            <React.Fragment key={target.id}>
              <line
                x1={cx}
                y1={cy}
                x2={target.x}
                y2={target.y}
                stroke={lineColor}
                strokeWidth="2"
                strokeDasharray="4 3"
                className="animate-pulse"
                opacity={target.isClamped ? 0.3 : 0.6}
              />
              {!target.isClamped && mapConfig.showDistanceText && (
                <text
                  x={(cx + target.x) / 2}
                  y={(cy + target.y) / 2 - 4}
                  fill={lineColor}
                  fontSize="8"
                  fontWeight="bold"
                  textAnchor="middle"
                >
                  {target.distM}{mapConfig.distanceUnit || 'm'}
                </text>
              )}
            </React.Fragment>
          ))}
        </svg>
      )}
      {otherBlips.map((blip: any) => (
        <div
          key={blip.id}
          className="absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{
            left: `${blip.x}px`,
            top: `${blip.y}px`
          }}
          title={blip.name}
        >
          <div 
             className="w-2 h-2 rounded-full border border-white/60 shadow-sm"
             style={{ backgroundColor: neutralColor }}
          />
          <div className="absolute top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[5px] text-white/70 font-mono">
            {Math.round(blip.worldX)}, {Math.round(blip.worldY)}
          </div>
        </div>
      ))}
      {enemyBlips.map((blip: any) => {
        const isTargeted = closestEnemy && closestEnemy.id === blip.id;
        return (
          <div
            key={blip.id}
            className="absolute transform -translate-x-1/2 -translate-y-1/2 flex items-center justify-center pointer-events-none"
            style={{
              left: `${blip.x}px`,
              top: `${blip.y}px`
            }}
          >
            <div
              className="absolute w-4 h-4 rounded-full animate-ping opacity-75"
              style={{ backgroundColor: enemyColor }}
            />
            <div
              className={`w-3 h-3 rounded-full border border-white flex items-center justify-center shadow-lg ${
                isTargeted ? 'ring-2 ring-white scale-110' : ''
              }`}
              style={{
                backgroundColor: enemyColor,
                boxShadow: `0 0 8px ${enemyColor}`
              }}
            >
              <Skull size={7} className="text-white" />
            </div>
            <div className="absolute top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[5px] text-white/70 font-mono">
              {Math.round(blip.worldX)}, {Math.round(blip.worldY)}
            </div>
          </div>
        );
      })}
      <div
        className="absolute transform -translate-x-1/2 -translate-y-1/2 z-10 flex items-center justify-center pointer-events-none"
        style={{ left: `${cx}px`, top: `${cy}px` }}
      >
        <div
          className="w-4 h-4 rounded-full border-2 border-white flex items-center justify-center shadow-lg animate-pulse relative"
          style={{
            backgroundColor: playerColor,
            boxShadow: `0 0 10px ${playerColor}`
          }}
        >
          <div className="w-1.5 h-1.5 bg-white rounded-full" />
          <div 
             className="absolute"
             style={{
               width: 0, height: 0,
               borderLeft: '4px solid transparent',
               borderRight: '4px solid transparent',
               borderBottom: `6px solid ${playerColor}`,
               top: '-8px',
               transformOrigin: '50% 16px',
               transform: `rotate(${mainCharRotation}deg)`
             }}
          />
        </div>
        <div className="absolute top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[5px] font-bold text-white/90 font-mono">
          {Math.round(sourceEl.x || 0)}, {Math.round(sourceEl.y || 0)}
        </div>
      </div>
      {mapConfig.label && (
        <div className="absolute top-1.5 left-2 text-[8px] font-mono font-bold tracking-widest text-white/80 uppercase">
          {mapConfig.label}
        </div>
      )}
      {mapConfig.type === 'compass_dial' && (
        <>
          <span className="absolute top-1 left-1/2 -translate-x-1/2 text-[8px] font-bold font-mono text-cyan-400">N</span>
          <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[8px] font-bold font-mono text-gray-400">S</span>
          <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[8px] font-bold font-mono text-gray-400">E</span>
          <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[8px] font-bold font-mono text-gray-400">W</span>
        </>
      )}
    </div>
  );
}

// --- Standalone Game Loading Renderer ---
function GameLoadingRenderer({ config, loadingConfig: propLoadingConfig, progress = 0, width: customWidth, height: customHeight }: any) {
  const loadingConfig = config || propLoadingConfig || {
    id: 'default_loading',
    name: 'Loading Screen',
    type: 'fullscreen_splash',
    position: 'fullscreen',
    title: 'LOADING GAME',
    subtitle: 'Preparing simulation world...',
    barColor: '#06b6d4',
    trackColor: '#18181b',
    glowColor: '#06b6d4',
    iconName: 'gamepad',
    width: 320,
    height: 90
  };
  const percent = Math.min(100, Math.max(0, Math.round(progress)));
  const barColor = loadingConfig.barColor || '#06b6d4';
  const trackColor = loadingConfig.trackColor || '#18181b';
  const glowColor = loadingConfig.glowColor || '#06b6d4';

  const renderIcon = () => {
    switch (loadingConfig.iconName) {
      case 'shield': return <Shield size={28} />;
      case 'gamepad': return <Gamepad2 size={28} />;
      case 'sparkles': return <Sparkles size={28} />;
      case 'flame': return <Flame size={28} />;
      case 'orbit': return <Orbit size={28} />;
      case 'zap': return <Zap size={28} />;
      case 'skull': return <Skull size={28} />;
      case 'swords': return <Swords size={28} />;
      case 'crown': return <Crown size={28} />;
      case 'compass': return <Navigation size={28} />;
      case 'timer': return <Timer size={28} />;
      default: return <Star size={28} />;
    }
  };

  if (loadingConfig.position === 'fullscreen' || loadingConfig.type === 'fullscreen_splash') {
    return (
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center p-6 bg-black/95 backdrop-blur-md text-white select-none pointer-events-auto">
        <div className="max-w-md w-full flex flex-col items-center gap-5 p-8 bg-zinc-900/60 border border-white/10 rounded-3xl shadow-2xl">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center border-2 animate-pulse"
            style={{
              backgroundColor: `${barColor}22`,
              borderColor: glowColor,
              color: barColor,
              boxShadow: `0 0 30px ${glowColor}55`
            }}
          >
            {renderIcon()}
          </div>
          <div className="text-center space-y-1">
            <h2 className="text-xl font-extrabold tracking-wider text-white uppercase">
              {loadingConfig.title || 'ANIMATO ARENA'}
            </h2>
            <p className="text-xs text-gray-400 max-w-xs">
              {loadingConfig.subtitle || 'Loading game assets and preparing world simulation...'}
            </p>
          </div>
          <div className="w-full space-y-2">
            <div
              className="w-full h-3.5 rounded-full overflow-hidden p-0.5 border"
              style={{ backgroundColor: trackColor, borderColor: `${barColor}44` }}
            >
              <div
                className="h-full rounded-full transition-all duration-100 ease-out"
                style={{
                  width: `${percent}%`,
                  backgroundColor: barColor,
                  boxShadow: `0 0 15px ${glowColor}`
                }}
              />
            </div>
            <div className="flex justify-between text-xs font-mono text-gray-400">
              <span>LOADING WORLD...</span>
              <span className="font-bold text-white" style={{ color: glowColor }}>{percent}%</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="p-4 rounded-2xl border border-white/10 bg-black/80 backdrop-blur-md shadow-2xl flex flex-col gap-2.5 pointer-events-none select-none"
      style={{ width: loadingConfig.width || 300 }}
    >
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs font-bold text-white">
          <span className="truncate flex items-center gap-1.5">
            <Gamepad2 size={14} className="text-cyan-400" />
            {loadingConfig.title || 'Loading Game Assets...'}
          </span>
          <span className="font-mono" style={{ color: glowColor }}>{percent}%</span>
        </div>
        <div
          className="w-full h-2.5 rounded-full overflow-hidden p-0.5 border border-white/5"
          style={{ backgroundColor: trackColor }}
        >
          <div
            className="h-full rounded-full transition-all duration-100"
            style={{
              width: `${percent}%`,
              backgroundColor: barColor,
              boxShadow: `0 0 10px ${glowColor}`
            }}
          />
        </div>
        {loadingConfig.subtitle && (
          <div className="text-[10px] text-gray-400 truncate">{loadingConfig.subtitle}</div>
        )}
      </div>
    </div>
  );
}

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
  const [gameMaps, setGameMaps] = useState<any[]>(() => gameData.gameMaps || []);
  const [gameLoadings, setGameLoadings] = useState<any[]>(() => gameData.gameLoadings || []);
  const [loadingProgressState, setLoadingProgressState] = useState<Record<string, number>>({});
  const [stageElements, setStageElements] = useState<any[]>([]);
  const cameraTargetRef = useRef<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
  const smoothCamRef = useRef<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
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
  const autoCameraStateRef = useRef<{
    active: boolean;
    movementType: string;
    target?: string;
    speed: number;
    radius: number;
    baseZoom: number;
    startTime: number;
    duration?: number;
  } | null>(null);
  const [attachments, setAttachments] = useState<any[]>(gameData.attachments || []);
  const [joystickStates, setJoystickStates] = useState<Record<string, { active: boolean, knobX?: number, knobY?: number, x: number, y: number, angle: number, normX: number, normY: number, distance: number }>>({});
  const joystickStatesRef = useRef<Record<string, any>>({});
  joystickStatesRef.current = joystickStates;
  const physicsStateRef = useRef<Record<string, { vy: number, vx: number, isGrounded: boolean, lastX?: number, lastY?: number }>>({});

  const handleJoystickPointerDown = (e: React.PointerEvent, elementId: string) => {
    e.preventDefault();
    e.stopPropagation();

    const target = e.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch (_) {}

    const rect = target.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const maxRadius = (rect.width / 2) * 0.75;

    const updateFromPointer = (clientX: number, clientY: number) => {
      const dx = clientX - centerX;
      const dy = clientY - centerY;
      const dist = Math.min(Math.hypot(dx, dy), maxRadius);
      const angle = Math.atan2(dy, dx);
      const normX = maxRadius > 0 ? (Math.cos(angle) * dist) / maxRadius : 0;
      const normY = maxRadius > 0 ? (Math.sin(angle) * dist) / maxRadius : 0;
      const knobX = Math.cos(angle) * dist;
      const knobY = Math.sin(angle) * dist;
      const degAngle = (angle * 180) / Math.PI;

      const newState = {
        active: true,
        knobX,
        knobY,
        x: normX,
        y: normY,
        normX,
        normY,
        angle: degAngle,
        distance: maxRadius > 0 ? dist / maxRadius : 0
      };
      joystickStatesRef.current[elementId] = newState;
      setJoystickStates(prev => ({ ...prev, [elementId]: newState }));
    };

    updateFromPointer(e.clientX, e.clientY);

    const onPointerMove = (moveEv: PointerEvent) => {
      if (moveEv.pointerId === e.pointerId) {
        updateFromPointer(moveEv.clientX, moveEv.clientY);
      }
    };

    const onPointerUp = (upEv: PointerEvent) => {
      if (upEv.pointerId === e.pointerId) {
        const releasedState = {
          active: false,
          knobX: 0,
          knobY: 0,
          x: 0,
          y: 0,
          normX: 0,
          normY: 0,
          angle: 0,
          distance: 0
        };
        joystickStatesRef.current[elementId] = releasedState;
        setJoystickStates(prev => ({ ...prev, [elementId]: releasedState }));
        try {
          target.releasePointerCapture(e.pointerId);
        } catch (_) {}
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };
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
      }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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

          cameraTargetRef.current = { zoom: targetZoom, x: targetX, y: targetY };
          break;
        }
        
        case 'auto_camera_movement': {
          const movementType = (act.movementType || act.value || 'orbit').toLowerCase();
          if (movementType === 'stop') {
            autoCameraStateRef.current = null;
          } else {
            const speed = Math.max(0.1, Math.min(10, Number(act.speed || 1.0)));
            const radius = Math.max(20, Math.min(2000, Number(act.radius || act.intensity || 200)));
            const baseZoom = Math.max(0.1, Math.min(5, Number(act.zoom ? act.zoom / 100 : (act.valueZoom ? act.valueZoom / 100 : 1.0))));
            const duration = Number(act.duration || 0);

            autoCameraStateRef.current = {
              active: true,
              movementType,
              target: act.target || '',
              speed,
              radius,
              baseZoom,
              startTime: Date.now(),
              duration: duration > 0 ? duration : undefined
            };
          }
          break;
        }

        case 'reset_camera': {
          autoCameraStateRef.current = null;
          cameraTargetRef.current = { zoom: 1, x: 0, y: 0 };
          break;
        }

        case 'set_loading_progress': {
          const targetId = act.target;
          const prog = Math.max(0, Math.min(100, Number(act.value ?? 100)));
          if (targetId) {
            setLoadingProgressState(prev => ({ ...prev, [targetId]: prog }));
          }
          setStageElements(prev => prev.map(el => {
            if (el.type === 'game_loading' && (!targetId || el.loadingId === targetId || el.id === targetId)) {
              return { ...el, progress: prog };
            }
            return el;
          }));
          break;
        }

        case 'start_loading_animation': {
          const targetId = act.target;
          const duration = Math.max(0.5, Number(act.value || act.duration || 3.0));
          // Instantly reveal the loading elements on stage if they are hidden
          setStageElements(prev => prev.map(el => {
            if (el.type === 'game_loading' && (!targetId || el.loadingId === targetId || el.id === targetId)) {
              return { ...el, hidden: false, opacity: 1 };
            }
            return el;
          }));

          const startTime = Date.now();
          const animInterval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            const prog = Math.min(100, (elapsed / duration) * 100);
            if (targetId) {
              setLoadingProgressState(prev => ({ ...prev, [targetId]: prog }));
            }
            setStageElements(prev => prev.map(el => {
              if (el.type === 'game_loading' && (!targetId || el.loadingId === targetId || el.id === targetId)) {
                return { ...el, progress: prog };
              }
              return el;
            }));
            if (prog >= 100) {
              clearInterval(animInterval);
            }
          }, 50);
          break;
        }

        case 'show_game_element': {
          if (act.target) {
            setStageElements(prev => prev.map(el => (el.id === act.target || (el as any).mapId === act.target || (el as any).loadingId === act.target) ? { ...el, hidden: false, opacity: 1 } : el));
          }
          break;
        }

        case 'hide_game_element': {
          if (act.target) {
            setStageElements(prev => prev.map(el => (el.id === act.target || (el as any).mapId === act.target || (el as any).loadingId === act.target) ? { ...el, hidden: true, opacity: 0 } : el));
          }
          break;
        }

        case 'configure_map': {
          const mapId = act.target;
          const sourceId = act.target2; // Origin Point
          const followTarget = act.target3; // Target for line
          const trackedIds = act.trackedTargetIds || (act.target4 ? [act.target4] : undefined);
          const showLine = act.showTrackingLine !== undefined ? act.showTrackingLine : true;
          
          setStageElements(prev => prev.map(el => {
            if (el.type === 'game_map' && (!mapId || el.id === mapId || el.mapId === mapId)) {
              const currentConfig = (el as any).mapConfig || {};
              return {
                ...el,
                mapConfig: {
                  ...currentConfig,
                  trackerSource: sourceId !== undefined ? sourceId : currentConfig.trackerSource,
                  targetEnemyId: followTarget !== undefined ? followTarget : currentConfig.targetEnemyId,
                  trackedTargetIds: trackedIds !== undefined ? trackedIds : currentConfig.trackedTargetIds,
                  showTrackingLine: showLine
                }
              };
            }
            return el;
          }));
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
                  ? { ...el, width: (el.width || 0) + addWidth }
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
                  ? { ...el, height: (el.height || 0) + addHeight }
                  : el
              )
            );
          }
          break;
        }

        case 'create_character': {
          const charId = act.target || act.value;
          if (charId) {
            const targetObj = (gameData.gameObjects || []).find((g: any) => g.id === charId);
            if (targetObj) {
              const newId = `created_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              setStageElements((prev) => [
                ...prev,
                {
                  id: newId,
                  type: 'obj',
                  data: charId,
                  x: Number(act.x ?? 100),
                  y: Number(act.y ?? 100),
                  width: targetObj.width || 100,
                  height: targetObj.height || 100,
                  zIndex: 10,
                  layerId: gameData.layers?.[0]?.id || 'layer_1'
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
      }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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
        }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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
        }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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
          }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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
            }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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
        }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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
        }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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
    } else if (cond.type === 'loading_progress') {
      const targetId = cond.target;
      const targetEl = stageElementsRef.current.find((el: any) => el.type === 'game_loading' && (!targetId || el.loadingId === targetId || el.id === targetId));
      if (!targetEl) return false;
      const currentProg = Number((targetEl as any).progress ?? 0);
      const targetProg = Number(cond.value ?? 100);
      const op = cond.operator || '>=';
      if (op === '>=') {
        if (currentProg < targetProg) return false;
      } else if (op === '==') {
        if (Math.abs(currentProg - targetProg) > 1) return false;
      } else if (op === '<=') {
        if (currentProg > targetProg) return false;
      }
    } else if (cond.type === 'map_target_in_range') {
      const mapId = cond.target;
      const mapEl = stageElementsRef.current.find((el: any) => el.type === 'game_map' && (!mapId || el.mapId === mapId || el.id === mapId));
      if (!mapEl) return false;
      const mapConfig = (gameData.gameMaps || []).find((m: any) => m.id === (mapEl as any).mapId) || mapEl;
      if (!mapConfig) return false;

      const trackerId = cond.target2 || mapConfig.trackerSource;
      const targetId = cond.target3 || mapConfig.targetEnemyId;

      let t1 = null;
      if (trackerId) t1 = stageElementsRef.current.find((el: any) => el.id === trackerId || el.data === trackerId);
      if (!t1) t1 = stageElementsRef.current.find((el: any) => el.type === 'obj' && ((el.name || '').toString().toLowerCase().includes('player') || (el.name || '').toString().toLowerCase().includes('hero') || (typeof el.data === 'string' ? el.data : '').toLowerCase().includes('player')));
      if (!t1) t1 = stageElementsRef.current.find((el: any) => el.type === 'obj');

      let t2 = null;
      if (targetId) t2 = stageElementsRef.current.find((el: any) => el.id === targetId || el.data === targetId);
      if (!t2 && t1) {
        const sourcePos = { x: (t1.x || 0) + (t1.width || 50)/2, y: (t1.y || 0) + (t1.height || 50)/2 };
        let minDistance = Infinity;
        let closest = null;
        stageElementsRef.current.forEach((el: any) => {
          if (!el || el.id === t1.id || el.hidden || el.type === 'bg' || el.type === 'game_map' || el.type === 'game_loading') return;
          const isEnemy = el.type === 'env_hazard' || (el.name || '').toString().toLowerCase().includes('enemy') || (el.name || '').toString().toLowerCase().includes('boss') || (el.name || '').toString().toLowerCase().includes('monster') || (el.name || '').toString().toLowerCase().includes('hazard') || (el.name || '').toString().toLowerCase().includes('ghost') || (el.name || '').toString().toLowerCase().includes('skull') || (el.name || '').toString().toLowerCase().includes('alien') || (typeof el.data === 'string' ? el.data : '').toLowerCase().includes('enemy');
          const isExplicitlyTracked = mapConfig.trackedTargetIds?.includes(el.id);
          if (isEnemy || isExplicitlyTracked) {
             const ex = (el.x || 0) + (el.width || 50) / 2;
             const ey = (el.y || 0) + (el.height || 50) / 2;
             const dist = Math.hypot(ex - sourcePos.x, ey - sourcePos.y);
             if (dist < minDistance) {
               minDistance = dist;
               closest = el;
             }
          }
        });
        t2 = closest;
      }

      if (!t1 || !t2) return false;
      const dx = ((t1.x || 0) + (t1.width || 50)/2) - ((t2.x || 0) + (t2.width || 50)/2);
      const dy = ((t1.y || 0) + (t1.height || 50)/2) - ((t2.y || 0) + (t2.height || 50)/2);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const range = Number(cond.value || 300);
      if (dist > range) return false;
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
      }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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

      // --- Loading Progress Auto-Increment ---
      setStageElements(prev => prev.map(el => {
        if (el.type === 'game_loading') {
          const lConfig = { ...(gameData.loadings?.find((l: any) => l.id === el.loadingId) || {}), ...(el.loadingConfig || {}) };
          if (lConfig.autoIncrement !== false) {
            const currentProgress = el.progress || 0;
            if (currentProgress < 100) {
              const inc = (100 / (lConfig.autoDuration || 3)) * dt;
              return { ...el, progress: Math.min(100, currentProgress + inc) };
            }
          }
        }
        return el;
      }));

      // Check if any camera joystick is actively engaged by user
      const isAnyCameraJoyActive = Object.entries(joystickStatesRef.current).some(([joyId, st]) => {
        if (!st?.active || st.distance < 0.05) return false;
        const joyEl = (stageElementsRef.current || []).find((el: any) => el.id === joyId);
        if (!joyEl) return false;
        const joyConfig = gameData.joysticks?.find((j: any) => j.id === joyEl.joystickId) || joyEl;
        return (
          joyEl.joystickType === 'camera' ||
          joyEl.type === 'camera' ||
          joyConfig.type === 'camera' ||
          joyEl.interactionType === 'pan' ||
          joyEl.interactionType === 'pan_camera' ||
          joyConfig.interactionType === 'pan' ||
          joyConfig.interactionType === 'pan_camera'
        );
      });

      // --- CAMERA FOLLOW & AUTO CAMERA MOVEMENT LOGIC ---
      if (!isAnyCameraJoyActive && autoCameraStateRef.current?.active) {
        const ac = autoCameraStateRef.current;
        if (ac.duration && (now - ac.startTime) > ac.duration * 1000) {
          autoCameraStateRef.current = null;
        } else {
          const t = ((now - ac.startTime) / 1000) * ac.speed;
          let cx = VIRTUAL_WIDTH / 2;
          let cy = VIRTUAL_HEIGHT / 2;

          if (ac.target) {
            const targetEl = stageElementsRef.current.find(el => el.id === ac.target || el.data === ac.target);
            if (targetEl) {
              cx = (targetEl.x || 0) + (targetEl.width || 50) / 2;
              cy = (targetEl.y || 0) + (targetEl.height || 50) / 2;
            }
          } else {
            const envEls = (stageElementsRef.current || []).filter(e => e && !e.hidden && (e.type === 'bg' || e.type === 'env_tile' || e.type === 'env_hazard' || e.type === 'obj'));
            if (envEls.length > 0) {
              let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
              envEls.forEach(e => {
                minX = Math.min(minX, e.x || 0);
                minY = Math.min(minY, e.y || 0);
                maxX = Math.max(maxX, (e.x || 0) + (e.width || 50));
                maxY = Math.max(maxY, (e.y || 0) + (e.height || 50));
              });
              if (minX !== Infinity && maxX !== -Infinity) {
                cx = (minX + maxX) / 2;
                cy = (minY + maxY) / 2;
              }
            }
          }

          let offX = 0;
          let offY = 0;
          let zoom = ac.baseZoom;

          switch (ac.movementType) {
            case 'runners':
              offX = Math.sin(t * 2.0) * (ac.radius * 0.6) + (ac.radius * 0.3);
              offY = Math.cos(t * 1.5) * (ac.radius * 0.25);
              zoom = ac.baseZoom * (1.1 + Math.sin(t * 3.0) * 0.08);
              break;
            case 'cinematic':
              offX = Math.sin(t * 0.7) * (ac.radius * 1.3);
              offY = Math.cos(t * 0.5) * (ac.radius * 0.6);
              zoom = ac.baseZoom * (1 + Math.sin(t * 0.4) * 0.2);
              break;
            case 'pan_horizontal':
              offX = Math.sin(t * 1.2) * (ac.radius * 1.5);
              offY = 0;
              zoom = ac.baseZoom;
              break;
            case 'pan_vertical':
              offX = 0;
              offY = Math.sin(t * 1.2) * (ac.radius * 1.2);
              zoom = ac.baseZoom;
              break;
            case 'zoom_pulse':
              offX = Math.sin(t * 0.8) * 30;
              offY = Math.cos(t * 0.8) * 20;
              zoom = ac.baseZoom * (1 + Math.sin(t * 2.0) * 0.35);
              break;
            case 'spiral': {
              const r = ac.radius * (0.4 + 0.6 * Math.abs(Math.sin(t * 0.5)));
              offX = Math.cos(t * 2.0) * r;
              offY = Math.sin(t * 2.0) * r;
              zoom = ac.baseZoom * (0.9 + 0.3 * Math.cos(t * 0.5));
              break;
            }
            case 'orbit':
            default:
              offX = Math.cos(t * 1.5) * ac.radius;
              offY = Math.sin(t * 1.5) * (ac.radius * 0.6);
              zoom = ac.baseZoom * (1 + Math.sin(t * 0.8) * 0.15);
              break;
          }

          const targetCamX = (VIRTUAL_WIDTH / 2) - (cx + offX);
          const targetCamY = (VIRTUAL_HEIGHT / 2) - (cy + offY);
          const clamped = clampCameraToBounds(targetCamX, targetCamY, zoom, stageElementsRef.current || [], VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
          const lerpFactor = Math.min(1, Math.max(0.04, ac.speed * 4 * dt));
          const smoothX = smoothCamRef.current.x + (clamped.x - smoothCamRef.current.x) * lerpFactor;
          const smoothY = smoothCamRef.current.y + (clamped.y - smoothCamRef.current.y) * lerpFactor;
          const smoothZoom = smoothCamRef.current.zoom + (zoom - smoothCamRef.current.zoom) * lerpFactor;
          smoothCamRef.current = { x: smoothX, y: smoothY, zoom: smoothZoom };
          
          // Sync manual targets
          cameraTargetRef.current = { x: smoothX, y: smoothY, zoom: smoothZoom };

          setGlobalCamera({ zoom: smoothZoom, x: smoothX, y: smoothY });
        }
      } else if (!isAnyCameraJoyActive && cameraFollowTargetRef.current && stageElementsRef.current) {
        const targetEl = stageElementsRef.current.find(el => el.id === cameraFollowTargetRef.current || el.data === cameraFollowTargetRef.current);
        if (targetEl) {
          const targetCX = (targetEl.x || 0) + (targetEl.width || 50) / 2;
          const targetCY = (targetEl.y || 0) + (targetEl.height || 50) / 2;
          
          const targetX = (VIRTUAL_WIDTH / 2) - targetCX;
          const targetY = (VIRTUAL_HEIGHT / 2) - targetCY;
          const followLerp = Math.min(1, Math.max(0.05, 6 * dt));
          const nextX = smoothCamRef.current.x + (targetX - smoothCamRef.current.x) * followLerp;
          const nextY = smoothCamRef.current.y + (targetY - smoothCamRef.current.y) * followLerp;
          const clamped = clampCameraToBounds(nextX, nextY, globalCameraRef.current.zoom, stageElementsRef.current || [], VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
          smoothCamRef.current.x = clamped.x;
          smoothCamRef.current.y = clamped.y;

          // Sync manual targets
          cameraTargetRef.current.x = clamped.x;
          cameraTargetRef.current.y = clamped.y;

          setGlobalCamera(cam => ({ ...cam, x: clamped.x, y: clamped.y }));
        }
      } else if (!isAnyCameraJoyActive) {
        // Smoothly interpolate towards manual target if set via camera_control
        const targetLerp = Math.min(1, Math.max(0.05, 8 * dt));
        const dx = cameraTargetRef.current.x - smoothCamRef.current.x;
        const dy = cameraTargetRef.current.y - smoothCamRef.current.y;
        const dz = cameraTargetRef.current.zoom - smoothCamRef.current.zoom;
        
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1 || Math.abs(dz) > 0.001) {
          smoothCamRef.current.x += dx * targetLerp;
          smoothCamRef.current.y += dy * targetLerp;
          smoothCamRef.current.zoom += dz * targetLerp;
          
          const clamped = clampCameraToBounds(smoothCamRef.current.x, smoothCamRef.current.y, smoothCamRef.current.zoom, stageElementsRef.current, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
          setGlobalCamera({ zoom: smoothCamRef.current.zoom, x: clamped.x, y: clamped.y });
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
          }, ev.id || ('ev_' + activeSceneId), { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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
                  const gObj = (gameData.gameObjects || []).find((g: any) => g.id === target.data) || target;
                  const assignedPlatform = prevElements.find((el: any) =>
                    (el.type === 'env_tile' || el.isPlatform) &&
                    (el.assignedCharacterId === target.id || el.assignedCharacterId === target.data)
                  );
                  const hasGravity = Boolean(gObj.hasGravity || target.hasGravity || assignedPlatform);

                  if (interactionType === 'move') {
                    const bounds = (() => {
                      const envEls = prevElements.filter((e: any) => e && !e.hidden && (e.type === 'bg' || e.type === 'env_tile' || e.type === 'env_hazard' || e.isPlatform));
                      if (envEls.length === 0) return { minX: 0, minY: 0, maxX: VIRTUAL_WIDTH, maxY: VIRTUAL_HEIGHT };
                      let minX = 0, minY = 0, maxX = VIRTUAL_WIDTH, maxY = VIRTUAL_HEIGHT;
                      envEls.forEach((e: any) => {
                        minX = Math.min(minX, e.x || 0);
                        minY = Math.min(minY, e.y || 0);
                        maxX = Math.max(maxX, (e.x || 0) + (e.width || 50));
                        maxY = Math.max(maxY, (e.y || 0) + (e.height || 50));
                      });
                      return { minX, minY, maxX, maxY };
                    })();

                    const nextX = (target.x || 0) + joyState.normX * speed * dt;
                    target.x = Math.max(bounds.minX, Math.min(bounds.maxX - (target.width || 50), nextX));

                    if (hasGravity) {
                      const pState = physicsStateRef.current[target.id] || physicsStateRef.current[target.data] || { vy: 0, vx: 0, isGrounded: false };
                      if (joyState.normY < -0.35 && pState.isGrounded) {
                        pState.vy = -520; 
                        if (Math.abs(joyState.normX) > 0.2) {
                          pState.vx = joyState.normX * speed * 1.5;
                        } else {
                          pState.vx = 0;
                        }
                        pState.isGrounded = false;
                        physicsStateRef.current[target.id] = pState;
                        if (target.data) physicsStateRef.current[target.data] = pState;
                      }
                    } else {
                      const nextY = (target.y || 0) + joyState.normY * speed * dt;
                      target.y = Math.max(bounds.minY, Math.min(bounds.maxY - (target.height || 50), nextY));
                    }

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

        // --- GRAVITY & PLATFORM PHYSICS LOOP ---
        prevElements.forEach((obj: any) => {
          if (obj.type !== 'obj' && obj.type !== 'character' && obj.type !== 'enemy') return;

          const isAttached = activeAtts.some((att: any) => att.childElementId === obj.id || att.childElementId === obj.data);
          if (isAttached) return;

          const gObj = (gameData.gameObjects || []).find((g: any) => g.id === obj.data) || obj;
          const assignedPlatform = prevElements.find((el: any) =>
            (el.type === 'env_tile' || el.isPlatform) &&
            (el.assignedCharacterId === obj.id || el.assignedCharacterId === obj.data)
          );
          const hasGravity = Boolean(gObj.hasGravity || obj.hasGravity || assignedPlatform);
          if (!hasGravity) return;

          const state = physicsStateRef.current[obj.id] || { vy: 0, vx: 0, isGrounded: false };
          const objX = obj.x || 0;
          const objW = obj.width || 50;
          const objH = obj.height || 50;

          // Apply horizontal velocity decay
          if (state.isGrounded) {
            state.vx *= 0.8;
          } else {
            state.vx *= 0.98;
          }
          if (Math.abs(state.vx) < 0.1) state.vx = 0;

          let nextY = obj.y || 0;
          let nextX = (obj.x || 0) + state.vx * dt;
          let isGrounded = false;
          let groundedPlatform: any = null;

          if (assignedPlatform) {
            const platX = assignedPlatform.x || 0;
            const platY = assignedPlatform.y || 0;
            const platW = assignedPlatform.width || 50;
            const platH = assignedPlatform.height || 50;

            const isOverPlatform = (objX + objW > platX) && (objX < platX + platW);
            if (isOverPlatform && ((obj.y || 0) + objH <= platY + 25 || state.isGrounded) && state.vy >= 0) {
              nextY = platY - objH;
              state.vy = 0;
              isGrounded = true;
              groundedPlatform = assignedPlatform;

              const platState = physicsStateRef.current[assignedPlatform.id];
              if (platState) {
                if (platState.lastX !== undefined) {
                  const dx = (assignedPlatform.x || 0) - platState.lastX;
                  nextX += dx;
                }
                if (platState.lastY !== undefined) {
                  const dy = (assignedPlatform.y || 0) - platState.lastY;
                  nextY += dy;
                }
              }
            } else {
              state.vy += 850 * dt;
              if (state.vy > 1000) state.vy = 1000;
              nextY = (obj.y || 0) + state.vy * dt;
              isGrounded = false;
            }
          } else {
            state.vy += 800 * dt;
            if (state.vy > 1000) state.vy = 1000;

            nextY = (obj.y || 0) + state.vy * dt;
            const objPrevBottom = (obj.y || 0) + objH;
            const objNextBottom = nextY + objH;

            const colliders = prevElements.filter((el: any) => {
              if (el.id === obj.id) return false;
              if (el.type === 'env_tile' || el.isPlatform) return true;
              if (el.type === 'env_hazard') return true;
              if (el.type === 'obj') {
                const baseEl = (gameData.gameObjects || []).find((g: any) => g.id === el.data) || el;
                if (baseEl.isPlatform || el.isPlatform) return true;
              }
              return false;
            });

            for (const tile of colliders) {
              const tileX = tile.x || 0;
              const tileY = tile.y || 0;
              const tileW = tile.width || 50;
              const tileH = tile.height || 50;

              if (objX + objW > tileX && objX < tileX + tileW) {
                if (state.vy > 0 && objPrevBottom <= tileY + 18 && objNextBottom >= tileY) {
                  nextY = tileY - objH;
                  state.vy = 0;
                  isGrounded = true;
                  groundedPlatform = tile;
                  break;
                }
              }
            }

            if (isGrounded && groundedPlatform) {
              const platState = physicsStateRef.current[groundedPlatform.id];
              if (platState && platState.lastX !== undefined) {
                const dx = (groundedPlatform.x || 0) - platState.lastX;
                nextX += dx;
              }
            }
          }

          state.isGrounded = isGrounded;
          state.lastX = nextX;
          state.lastY = nextY;
          physicsStateRef.current[obj.id] = state;
          if (obj.data) physicsStateRef.current[obj.data] = state;

          if (nextY !== obj.y || nextX !== obj.x) {
            obj.y = nextY;
            obj.x = nextX;
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
          } else if (el.clampToStage && !isFollowingThis && el.type === 'obj') {
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
        }, evKey, { activeKeysDown: activeKeysDown.current, evaluateSingleCondition, allEvents: sceneEvents })) {
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

              const btnTemplate = (el.type === 'btn' && (el as any).buttonId) ? (gameData.uiButtons || []).find((b: any) => b.id === (el as any).buttonId) : null;
              const elemSrc = typeof el.url === 'string' ? el.url : (typeof el.data === 'string' ? el.data : (el.data?.src || el.data?.texture || (typeof btnTemplate?.url === 'string' ? btnTemplate.url : (typeof btnTemplate?.data === 'string' ? btnTemplate.data : ''))));
              const isShape = elemSrc === 'rect' || elemSrc === 'circle';
              const isEnv = ['env_tile', 'env_hazard', 'env_light', 'env_weather'].includes(el.type);
              const finalBgImage = (el.type !== 'obj' && el.type !== 'video' && !isEnv && elemSrc && !isShape) ? `url("${elemSrc}")` : undefined;

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
                  {el.type === 'env_tile' && (
                    <div className="w-full h-full rounded shadow-[inset_0_2px_4px_rgba(255,255,255,0.2),inset_0_-4px_8px_rgba(0,0,0,0.5),0_4px_8px_rgba(0,0,0,0.5)] border border-white/10 relative overflow-hidden" style={{ backgroundColor: el.data?.color, backgroundImage: el.data?.texture ? `url("${el.data.texture}")` : undefined, backgroundSize: '100% 100%' }}>
                    </div>
                  )}
                  {el.type === 'env_hazard' && (
                    <div className="w-full h-full relative" style={{ backgroundColor: el.data?.texture === 'water' ? 'rgba(59, 130, 246, 0.4)' : 'transparent', borderTop: el.data?.texture === 'water' ? '4px solid rgba(96, 165, 250, 0.8)' : 'none' }}>
                      {el.data?.name === 'Spikes' && (
                        <div className="absolute bottom-0 w-full h-1/2 flex items-end justify-between px-1 text-red-500 overflow-hidden">
                          {Array.from({length: Math.max(1, Math.floor((el.width || 100) / 30))}).map((_, i) => (
                             <Triangle key={i} size={30} fill="currentColor" style={{ flexShrink: 0 }} />
                          ))}
                        </div>
                      )}
                      {el.data?.texture === 'water' && (
                        <div className="absolute inset-0 overflow-hidden">
                           <div className="w-[200%] h-4 bg-[url('data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 10' preserveAspectRatio='none'%3E%3Cpath d='M0 10 Q 25 0, 50 10 T 100 10 L 100 20 L 0 20 Z' fill='%2360a5fa'%3E%3C/path%3E%3C/svg%3E')] animate-[scrollWater_2s_linear_infinite]" style={{backgroundSize: '50% 100%'}}></div>
                        </div>
                      )}
                    </div>
                  )}
                  {el.type === 'env_light' && (
                    <div className="w-full h-full rounded-full" style={{ background: `radial-gradient(circle, ${el.data?.color} 0%, transparent 70%)`, mixBlendMode: 'screen', opacity: 1 }}>
                    </div>
                  )}
                  {el.type === 'env_weather' && (
                    <div className="w-full h-full overflow-hidden pointer-events-none">
                      {el.data?.fx === 'fog' && (
                        <div className="absolute inset-0 opacity-50 bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] mix-blend-screen animate-[float_10s_ease-in-out_infinite]"></div>
                      )}
                      {el.data?.fx === 'lightning' && (
                        <>
                          <div className="absolute inset-0 animate-[lightningFlash_4s_ease-in-out_infinite] bg-white mix-blend-overlay opacity-0"></div>
                          <div className="absolute top-0 left-1/4 w-[2px] h-full bg-cyan-100 shadow-[0_0_15px_#fff] animate-[lightningBolt_4s_ease-in-out_infinite] opacity-0 origin-top"></div>
                          <div className="absolute top-0 right-1/3 w-[1.5px] h-2/3 bg-white shadow-[0_0_10px_#fff] animate-[lightningBolt_5s_infinite] opacity-0 origin-top delay-700"></div>
                        </>
                      )}
                      {el.data?.fx === 'rain' && (
                        <div className="absolute inset-0 opacity-40 pointer-events-none">
                          <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] animate-[rainFall_0.5s_linear_infinite]"></div>
                        </div>
                      )}
                      {el.data?.fx === 'snow' && (
                        <div className="absolute inset-0 opacity-60 pointer-events-none">
                          <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] animate-[snowDrift_3s_linear_infinite]"></div>
                        </div>
                      )}
                    </div>
                  )}
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


                  {/* Active Movement Direction Arrow Overlay */}
                  {null}
                </div>
              );
            })}
          </div>

          {/* 2. UI / HUD LAYER: Fixed to screen, completely unaffected by camera */}
          <div 
            id="hud_ui_layer"
            className="absolute inset-0 w-full h-full pointer-events-none z-[60000]"
          >
            {stageElements.filter(el => (el.type === 'btn' || el.type === 'joystick' || el.type === 'game_map' || el.type === 'game_loading') && !el.hidden).map((el, i) => {
              const finalZ = computeElementZIndex(el, gameData.layers || [], {});

              const isVibrating = el.vibrating;
              const vibrateClass = isVibrating ? (isVibrating === 'once' ? 'animate-[vibrate_0.3s_linear]' : 'animate-[vibrate_0.1s_linear_infinite]') : '';
              const filterStyle = el.glowColor ? `drop-shadow(0 0 15px ${el.glowColor})` : (el.colorFilter ? `hue-rotate(90deg) drop-shadow(0 0 8px ${el.colorFilter})` : undefined);

              const btnTemplate = (el.type === 'btn' && el.buttonId) ? (gameData.uiButtons || []).find((b: any) => b.id === el.buttonId) : null;
              let elemSrc = el.url || el.data || btnTemplate?.url || btnTemplate?.data || '';
              
              const isShape = elemSrc === 'rect' || elemSrc === 'circle';
              const finalBgImage = (elemSrc && !isShape && el.type === 'btn') ? `url("${elemSrc}")` : undefined;
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
                  className={`absolute select-none ${vibrateClass} ${elemSrc === 'circle' && el.type === 'btn' ? 'rounded-full' : ''}`}
                  style={{
                    left: el.x,
                    top: el.y,
                    width: el.width ? `${el.width}px` : (el.type === 'game_loading' ? '320px' : el.type === 'game_map' ? '170px' : '100px'),
                    height: el.height ? `${el.height}px` : (el.type === 'game_loading' ? '90px' : el.type === 'game_map' ? '170px' : '100px'),
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
                    pointerEvents: (el.type === 'btn' || el.type === 'joystick' || el.type === 'game_loading') ? 'auto' : 'none',
                    touchAction: el.type === 'joystick' ? 'none' : 'auto',
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
                    <VirtualJoystickRenderer
                      id={el.id}
                      type={(gameData.joysticks?.find((j: any) => j.id === el.joystickId)?.type) || el.joystickType || 'movement'}
                      name={(gameData.joysticks?.find((j: any) => j.id === el.joystickId)?.name) || 'Joystick'}
                      design={el.design || (gameData.joysticks?.find((j: any) => j.id === el.joystickId)?.design) || 'classic-ring'}
                      color={el.customColor || (gameData.joysticks?.find((j: any) => j.id === el.joystickId)?.color) || ((gameData.joysticks?.find((j: any) => j.id === el.joystickId)?.type === 'camera' || el.joystickType === 'camera') ? '#eab308' : '#3b82f6')}
                      knobColor={el.knobColor || (gameData.joysticks?.find((j: any) => j.id === el.joystickId)?.knobColor) || ((gameData.joysticks?.find((j: any) => j.id === el.joystickId)?.type === 'camera' || el.joystickType === 'camera') ? '#fde047' : '#60a5fa')}
                      url={el.url || (gameData.joysticks?.find((j: any) => j.id === el.joystickId)?.url)}
                      state={joystickStates[el.id]}
                      onPointerDown={handleJoystickPointerDown}
                      width={el.width}
                      height={el.height}
                      interactive={true}
                    />
                  )}
                  {el.type === 'btn' && (
                    <button className="w-full h-full flex items-center justify-center bg-transparent border-0 text-white font-bold cursor-pointer select-none">
                      {el.text || ''}
                    </button>
                  )}
                  {el.type === 'game_map' && (
                    <GameMapRenderer
                      config={{
                        ...((gameData.gameMaps || []).find((m: any) => m.id === (el as any).mapId) || {}),
                        ...((el as any).mapConfig || {})
                      }}
                      stageElements={stageElements}
                      gameObjects={gameData.gameObjects || []}
                      joystickStates={joystickStatesRef.current}
                      virtualWidth={VIRTUAL_WIDTH}
                      virtualHeight={VIRTUAL_HEIGHT}
                    />
                  )}
                  {el.type === 'game_loading' && (
                    <GameLoadingRenderer
                      config={{
                        ...((gameData.gameLoadings || []).find((l: any) => l.id === (el as any).loadingId) || {}),
                        ...((el as any).loadingConfig || {})
                      }}
                      progress={loadingProgressState[(el as any).loadingId] !== undefined ? loadingProgressState[(el as any).loadingId] : ((el as any).progress || 0)}
                      width={el.width}
                      height={el.height}
                    />
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

// --- Error Boundary for Deployed Builds ---
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("Game Render Error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', background: '#111', color: '#ff4d4d', fontFamily: 'monospace', height: '100vh', width: '100vw', overflow: 'auto', boxSizing: 'border-box' }}>
          <h2 style={{ margin: '0 0 10px 0' }}>Game Runtime Error</h2>
          <pre style={{ background: '#222', padding: '15px', color: '#fff', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {this.state.error && this.state.error.toString()}
          </pre>
          <pre style={{ background: '#222', padding: '15px', color: '#888', overflowX: 'auto', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {this.state.error && this.state.error.stack}
          </pre>
          <button onClick={() => window.location.reload()} style={{ marginTop: '20px', padding: '10px 20px', background: '#fff', color: '#000', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
            Reload Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
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
        <ErrorBoundary>
          <ActiveGame />
        </ErrorBoundary>
      )}
    </div>
  );
}
