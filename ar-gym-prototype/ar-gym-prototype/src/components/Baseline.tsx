/**
 * Plain-text baseline: one static card with a few text tips. No glasses, no
 * camera, no panel, no voting, no audio and no decay, so the team can compare
 * it against the full experience.
 */
import { useEffect, useMemo } from 'react';
import type { Breadcrumb, Station } from '../../shared/types';
import { buzz } from '../lib/feedback';
import { track } from '../lib/tracker';
import { IconArrow } from './Icons';

interface Props {
  station: Station;
  breadcrumbs: Breadcrumb[];
  onFinish: () => void;
}

export function Baseline({ station, breadcrumbs, onFinish }: Props) {
  // The same seeded tips for everyone, in a fixed order: static by design.
  const tips = useMemo(
    () =>
      breadcrumbs
        .filter((b) => b.kind === 'text' && b.contributor.is_seeded && !b.is_flagged)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 4),
    [breadcrumbs],
  );

  useEffect(() => {
    track('baseline_viewed', { tips: tips.length });
  }, [tips.length]);

  return (
    <main className="screen baseline">
      <section className="panel plain-card baseline-card">
        <p className="eyebrow">Tips for this station</p>
        <h1>{station.name}</h1>
        <ol className="baseline-list">
          {tips.map((tip) => (
            <li key={tip.id}>{tip.body}</li>
          ))}
        </ol>
        <p className="fine">Try a few seated presses with your water bottles, then tap Done.</p>
        <button type="button" className="btn btn-primary btn-xl btn-wide" onClick={() => (buzz(), onFinish())}>
          <span>Done</span>
          <IconArrow />
        </button>
      </section>
    </main>
  );
}
