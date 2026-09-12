/**
 * References to one column or one card of a board, as a link the reader can copy and follow.
 *
 * A reference is a note path with one parameter on it, `?column=` or `?card=`, which `link.ts`
 * carries in the pane's view scope the same way `?bookmark=` is carried. The board reads it once as
 * it draws and reveals what it names; see {@link useBoardReference}.
 *
 * A card is named by its note id, which it already has. A column is named by an id of its own,
 * stored in `board.json` beside the rest of what the column is drawn with, because the value its
 * cards carry is rewritten whenever the column is renamed.
 */

import { boardColumnsKey, boardGroupByFromColumnsKey } from "@triliumnext/commons";
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

import type NoteContext from "../../../components/note_context";
import froca from "../../../services/froca";
import { t } from "../../../services/i18n";
import toast from "../../../services/toast";
import { randomString } from "../../../services/utils";
import type { BoardColumnData, BoardViewData } from ".";
import type BoardApi from "./api";
import { askForCard } from "./windowing";

/** How long a column id is, matching the length of a note id so the two read alike. */
export const COLUMN_ID_LENGTH = 12;

/** How many frames the reveal waits for the board to draw what a reference names. */
const REVEAL_TRIES = 30;

/** A fresh column id. `randomString` rather than `crypto.randomUUID`, which needs a secure context. */
export function newColumnId() {
    return randomString(COLUMN_ID_LENGTH);
}

/** Where a column reference points: the grouping that owns the column, and the column itself. */
export interface ColumnReferenceTarget {
    /** The grouping the column belongs to, as `#board:groupBy` writes it. */
    groupBy: string;
    /** The value the column's cards carry, which is what the board draws it by. */
    value: string;
}

/**
 * Finds the column an id names, in whichever grouping stores it.
 *
 * Every grouping keeps a column list of its own, so an id can belong to a grouping other than the
 * one the board is showing. The board switches to the grouping named here rather than reporting the
 * column missing.
 */
export function findColumnById(
    config: BoardViewData | undefined, id: string
): ColumnReferenceTarget | undefined {
    if (!config || !id) {
        return undefined;
    }

    for (const [ key, value ] of Object.entries(config)) {
        const groupBy = boardGroupByFromColumnsKey(key);
        if (!groupBy || !Array.isArray(value)) {
            continue;
        }

        const column = (value as BoardColumnData[]).find(candidate => candidate?.id === id);
        if (column) {
            return { groupBy, value: column.value };
        }
    }

    return undefined;
}

/** The stored id of a column of one grouping, or nothing where it has none yet. */
export function readColumnId(
    config: BoardViewData | undefined, groupBy: string, value: string
): string | undefined {
    const columns = config?.[boardColumnsKey(groupBy)] as BoardColumnData[] | undefined;
    return columns?.find(column => column.value === value)?.id;
}

/** The link that opens a board on one of its columns. */
export function columnReference(notePath: string, columnId: string) {
    return `#${notePath}?column=${encodeURIComponent(columnId)}`;
}

/** The link that opens a board on one of its cards. */
export function cardReference(notePath: string, noteId: string) {
    return `#${notePath}?card=${encodeURIComponent(noteId)}`;
}

/**
 * What a reference the board has taken off its view scope points at, and which board it was
 * taken for: `BoardView` is drawn unkeyed, so moving to another board reuses the instance and a
 * reference still waiting for its column must not settle on the board that followed.
 */
type BoardReferenceTarget = { board: string } & (
    | { kind: "column"; id: string }
    | { kind: "card"; noteId: string }
);

export interface BoardReferenceOptions {
    /** The board the reference is settled against. */
    noteId: string;
    /** The pane the board is drawn in, whose view scope carries the reference. */
    noteContext: NoteContext | null | undefined;
    api: BoardApi;
    /** The board's stored configuration, which every grouping's columns are read from. */
    viewConfig: BoardViewData | undefined;
    /** The grouping the board draws for. */
    groupBy: string;
    /** Switches the board to another grouping, by writing `#board:groupBy`. */
    setGroupBy: (groupBy: string) => void;
    /** The columns the board draws, absent until they are resolved. */
    columns: string[] | undefined;
    /** Whether the board draws archived columns and cards. */
    includeArchived: boolean;
    /** Draws a collapsed column open, without storing it as open. */
    selectColumn: (column: string) => void;
    /** The board's own element, which what is revealed is looked for in. */
    containerRef: RefObject<HTMLElement>;
}

/**
 * Reveals the column or card a reference names, once the board has drawn it.
 *
 * The reference is taken off the view scope and cleared as soon as it is read, so that it fires
 * once: a pane stores its view scope in the tab's state, and an unconsumed parameter would jump the
 * board again every time the tab is restored. What it names is then waited for rather than looked
 * for at once, because the columns are resolved a moment after the board mounts, a grouping switch
 * takes another round, and a long column draws only the slice of cards around what is in view.
 */
export function useBoardReference({
    noteId, noteContext, api, viewConfig, groupBy, setGroupBy, columns, includeArchived,
    selectColumn, containerRef
}: BoardReferenceOptions) {
    const target = useRef<BoardReferenceTarget | null>(null);
    /** The grouping a column reference has already asked for, so the switch is requested once. */
    const switchedTo = useRef<string | null>(null);

    // No dependency list: the reference is settled against whatever the board has drawn so far, and
    // every render is a chance that what it names is now there.
    useEffect(() => {
        const viewScope = noteContext?.viewScope;
        if (viewScope?.column || viewScope?.card) {
            target.current = viewScope.column
                ? { board: noteId, kind: "column", id: viewScope.column }
                : { board: noteId, kind: "card", noteId: viewScope.card ?? "" };
            switchedTo.current = null;
            viewScope.column = undefined;
            viewScope.card = undefined;
        }

        const pending = target.current;
        if (pending && pending.board !== noteId) {
            target.current = null;
            return;
        }

        if (!pending || !columns || !containerRef.current) {
            return;
        }

        const settled = pending.kind === "column"
            ? settleColumn(pending.id)
            : settleCard(pending.noteId);
        if (settled) {
            target.current = null;
        }
    });

    /** @returns whether the reference is done with, a report of its own counting as done. */
    function settleColumn(id: string) {
        const found = findColumnById(viewConfig, id);
        if (!found) {
            toast.showMessage(t("board_view.reference-column-missing"), undefined, "bx bx-columns");
            return true;
        }

        // The column belongs to another grouping, so the board is switched to it and the reference
        // settled on the round that follows. Asked for once: the label takes a moment to come back
        // through froca, and every render in between would ask again.
        if (found.groupBy !== groupBy) {
            if (switchedTo.current !== found.groupBy) {
                switchedTo.current = found.groupBy;
                setGroupBy(found.groupBy);
            }
            return false;
        }

        if (!columns?.includes(found.value)) {
            reportMissing(api.isColumnArchived(found.value), "bx bx-columns");
            return true;
        }

        revealColumn(found.value);
        return true;
    }

    /** @returns whether the reference is done with. */
    function settleCard(noteId: string) {
        const column = api.getCardColumn(noteId);
        if (column === undefined) {
            const note = froca.getNoteFromCache(noteId);
            reportMissing(!!note?.isArchived, "bx bx-card");
            return true;
        }

        // A collapsed column keeps its cards in the page without drawing them, so the card is
        // focusable before it can be seen. The column is peeked open rather than stored as open:
        // the reader is being shown one card, not rearranging the board.
        if (api.isColumnCollapsed(column)) {
            selectColumn(column);
        }

        const index = api.getColumnNoteIds(column).indexOf(noteId);
        revealCard(noteId, column, Math.max(index, 0));
        return true;
    }

    /** Says why what a reference names is not on the board, which is usually that it is archived. */
    function reportMissing(isArchived: boolean, icon: string) {
        toast.showMessage(
            isArchived && !includeArchived
                ? t("board_view.reference-archived")
                : t("board_view.reference-missing"),
            undefined,
            icon);
    }

    function revealColumn(value: string) {
        if (api.isColumnCollapsed(value)) {
            selectColumn(value);
        }

        waitFor(() => {
            const column = containerRef.current?.querySelector<HTMLElement>(
                `.board-column[data-column="${quoteForSelector(value)}"]`);
            // Waited for open rather than focused where it stands: focus arriving on a column that
            // is not yet the active one closes the peek just asked for (see Column#handleFocusIn).
            if (!column || column.classList.contains("collapsed")) {
                return null;
            }

            return column.querySelector<HTMLElement>("h3");
        }, reveal);
    }

    function revealCard(noteId: string, column: string, index: number) {
        waitFor(
            () => {
                const container = containerRef.current;
                const card = findCardElement(container, noteId);
                if (!card && container) {
                    // The card sits outside the slice a long column draws, so the column is asked
                    // to draw it before there is anything to reveal.
                    askForCard(container, column, index);
                }

                return card;
            },
            reveal);
    }
}

/** Puts what a reference names in view and on the focus, which is how it is picked out. */
function reveal(element: HTMLElement) {
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
}

/**
 * Runs `find` each frame until it answers with an element, for at most {@link REVEAL_TRIES} frames.
 *
 * The board draws the columns a moment after it mounts, and a windowed column draws a card a frame
 * after it is asked to, so what a reference names is rarely in the page on the first look.
 */
function waitFor(
    find: () => HTMLElement | null, then: (element: HTMLElement) => void, tries = REVEAL_TRIES
) {
    const found = find();
    if (found) {
        then(found);
        return;
    }

    if (tries > 0) {
        requestAnimationFrame(() => waitFor(find, then, tries - 1));
    }
}

/** Found by the note it stands for rather than by where it sits, as the keyboard walk finds it. */
function findCardElement(container: HTMLElement | null, noteId: string) {
    return container?.querySelector<HTMLElement>(`.board-note[data-note-id="${noteId}"]`) ?? null;
}

/**
 * A column value as a quoted attribute selector can carry it. Column values are user text, and a
 * quote or a backslash in one would end the selector's string rather than fail to match.
 */
function quoteForSelector(value: string) {
    return value.replace(/[\\"]/g, "\\$&");
}
