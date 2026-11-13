/**
 * The Breadcrumbs panel shell. With the phone sideways it slides in from the
 * right and takes a little under half of the lens, so the room stays visible
 * on the left. With the phone upright it is a bottom sheet. It closes three
 * ways: the Close button (always there), tapping the room beside it, or
 * swiping its header away (down when upright, to the right when sideways).
 */
import { useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { useIsPortrait } from '../lib/device';
import { buzz } from '../lib/feedback';
import { IconClose } from './Icons';

interface Props {
  /** Accessible name, and the visible title unless `heading` replaces it. */
  title: string;
  /** Replaces the title text. */
  heading?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Extra content pinned under the title (tabs, filters). */
  toolbar?: ReactNode;
  /** Pinned to the bottom of the panel (the Add button). */
  footer?: ReactNode;
  tall?: boolean;
  /** Do not close when the room above is tapped (used while typing a tip, so a stray tap cannot lose it). */
  keepOpenOnOutsideTap?: boolean;
}

const CLOSE_DISTANCE = 80;

export function Sheet({ title, heading, subtitle, onClose, children, toolbar, footer, tall, keepOpenOnOutsideTap }: Props) {
  const [drag, setDrag] = useState(0);
  const startY = useRef<number | null>(null);
  // Kept in a ref as well, so a very quick flick is judged by where the finger really got to.
  const dragged = useRef(0);
  // Upright: the panel is a bottom sheet and drags down. Sideways: a side panel that drags right.
  const portrait = useIsPortrait();
  const along = (event: TouchEvent) => (portrait ? event.touches[0].clientY : event.touches[0].clientX);

  const close = () => {
    buzz();
    onClose();
  };
  const onTouchStart = (event: TouchEvent) => {
    startY.current = along(event);
    dragged.current = 0;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (startY.current === null) return;
    dragged.current = Math.max(0, along(event) - startY.current);
    setDrag(dragged.current);
  };
  const onTouchEnd = () => {
    if (dragged.current > CLOSE_DISTANCE) close();
    dragged.current = 0;
    startY.current = null;
    setDrag(0);
  };

  return (
    <>
      {/* The room beside the panel: tapping it puts the panel away. */}
      {keepOpenOnOutsideTap ? (
        <div className="sheet-scrim" aria-hidden="true" />
      ) : (
        // Hidden from assistive tech: the labelled Close button does the same thing.
        <button type="button" className="sheet-scrim" aria-hidden="true" tabIndex={-1} onClick={close} />
      )}
      <section
        className={`sheet${tall ? ' sheet-tall' : ''}`}
        role="dialog"
        aria-label={title}
        style={drag ? { transform: portrait ? `translateY(${drag}px)` : `translateX(${drag}px)`, transition: 'none' } : undefined}
      >
        <header className="sheet-header">
          {/* Only the header row drags, so scrolling the list or the filters never closes the panel. */}
          <div className="sheet-handle" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
            <div className="sheet-grip" />
            <div className="sheet-title-row">
              <div className="sheet-heading">
                {heading ?? <h2>{title}</h2>}
                {subtitle && <p className="sheet-subtitle">{subtitle}</p>}
              </div>
              <button type="button" className="btn btn-quiet btn-close" onClick={close}>
                <IconClose size={18} />
                <span className="close-label">Close</span>
              </button>
            </div>
          </div>
          {toolbar}
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </section>
    </>
  );
}
