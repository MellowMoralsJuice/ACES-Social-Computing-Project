/**
 * The contents of one tab: the top three cards, "See more", and a line saying
 * how many tips faded away. Filter chips sit above the list.
 */
import { TAGS } from '../../shared/text';
import type { VoteValue } from '../../shared/types';
import type { CrumbView, TabList } from '../lib/crumbs';
import { buzz } from '../lib/feedback';
import { BreadcrumbCard } from './BreadcrumbCard';

interface Props {
  list: TabList;
  kind: 'text' | 'audio';
  highlightedId: string | null;
  showMore: boolean;
  /** A filter chip is on, so "nothing here" may just mean "nothing with that tag". */
  filtered: boolean;
  onShowMore: () => void;
  onVote: (view: CrumbView, value: VoteValue) => void;
  onHelped: (view: CrumbView, note?: string) => void;
  onPlayToggle: (view: CrumbView) => void;
  onTranscript: (view: CrumbView, open: boolean) => void;
  onNotesSeen: (view: CrumbView) => void;
}

export function TagFilters({ tag, onTag }: { tag: string | null; onTag: (tag: string | null) => void }) {
  const chip = (key: string | null, label: string) => (
    <button
      key={label}
      type="button"
      className={`chip${tag === key ? ' is-on' : ''}`}
      aria-pressed={tag === key}
      onClick={() => {
        buzz();
        onTag(key);
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="chip-row" role="group" aria-label="Filter tips">
      {chip(null, 'All')}
      {TAGS.map((t) => chip(t.key, t.label))}
    </div>
  );
}

export function BreadcrumbList(props: Props) {
  const { list, highlightedId, showMore, kind } = props;
  const shown = showMore ? [...list.top, ...list.more] : list.top;
  // Gone cards stay mounted (collapsed) so the fade-out can animate.
  const cards = [...shown, ...list.gone];
  const noun = kind === 'audio' ? 'audio tips' : 'text tips';

  return (
    <div className="crumb-list">
      {shown.length === 0 && (
        <p className="empty">
          {list.total === 0
            ? props.filtered
              ? `No ${noun} with that filter.`
              : `No ${noun} yet. Yours could be the first.`
            : 'Nothing fresh here right now.'}
        </p>
      )}

      {cards.map((view) => (
        <BreadcrumbCard
          key={view.crumb.id}
          view={view}
          highlighted={highlightedId === view.crumb.id}
          onVote={(value) => props.onVote(view, value)}
          onHelped={(note) => props.onHelped(view, note)}
          onPlayToggle={() => props.onPlayToggle(view)}
          onTranscript={(open) => props.onTranscript(view, open)}
          onNotesSeen={() => props.onNotesSeen(view)}
        />
      ))}

      {!showMore && list.more.length > 0 && (
        <button
          type="button"
          className="btn btn-quiet btn-wide btn-more"
          onClick={() => {
            buzz();
            props.onShowMore();
          }}
        >
          See {list.more.length} more
        </button>
      )}

      {list.gone.length > 0 && (
        <p className="faded-note">
          <span>
            {list.gone.length} {list.gone.length === 1 ? 'tip' : 'tips'} faded away
          </span>
        </p>
      )}
    </div>
  );
}
