/**
 * The rear camera, seen through the lens of the glasses. Rear camera only: there is no flip.
 *
 * Frames never leave the phone: nothing is recorded, analyzed or uploaded. If
 * permission is denied or no camera exists, a static backdrop is shown and the
 * app keeps working. When the browser returns from the background the stream
 * restarts, so the participant never comes back to a frozen or black view.
 */
import { useEffect, useRef, useState } from 'react';

export type CameraStatus = 'idle' | 'starting' | 'live' | 'denied' | 'unavailable';

interface Props {
  /** Start (or keep) the camera. False = show the static backdrop. */
  enabled: boolean;
  onStatus: (status: CameraStatus) => void;
}

export function Camera({ enabled, onStatus }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);
  const report = useRef(onStatus);
  useEffect(() => {
    report.current = onStatus;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let starting = false;

    const stop = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    const start = async () => {
      if (starting || cancelled) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        report.current('unavailable');
        return;
      }
      starting = true;
      report.current('starting');
      try {
        // The rear camera, looking at the room. A laptop with only a front camera still gets a picture.
        const next = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        stop();
        stream = next;
        // If the phone takes the camera away (another app, a call), start it again.
        next.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (cancelled || stream !== next) return;
          setLive(false);
          if (document.visibilityState === 'visible') void start();
        });
        const video = videoRef.current;
        if (video) {
          video.srcObject = next;
          // iOS needs muted + playsInline for autoplay; play() may still reject, which is fine.
          await video.play().catch(() => undefined);
        }
        setLive(true);
        report.current('live');
      } catch (error) {
        if (cancelled) return;
        setLive(false);
        const name = error instanceof DOMException ? error.name : '';
        report.current(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
      } finally {
        starting = false;
      }
    };
    void start();

    const onVisible = () => {
      if (document.visibilityState !== 'visible' || cancelled) return;
      const track = stream?.getVideoTracks()[0];
      const video = videoRef.current;
      if (!track || track.readyState === 'ended') void start();
      else if (video?.paused) void video.play().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      stop();
      setLive(false);
    };
  }, [enabled]);

  return (
    <div className="camera" aria-hidden="true">
      <div className="camera-backdrop" />
      <video ref={videoRef} className={`camera-video${live ? ' is-live' : ''}`} playsInline muted autoPlay />
      <div className="camera-shade" />
    </div>
  );
}
