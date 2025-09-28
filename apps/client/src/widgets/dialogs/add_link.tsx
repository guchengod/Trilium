import { t } from "../../services/i18n";
import Modal from "../react/Modal";
import Button from "../react/Button";
import FormRadioGroup from "../react/FormRadioGroup";
import NoteAutocomplete from "../react/NoteAutocomplete";
import { useRef, useState, useEffect } from "preact/hooks";
import tree from "../../services/tree";
import note_autocomplete, { Suggestion } from "../../services/note_autocomplete";
import { default as TextTypeWidget } from "../type_widgets/editable_text.js";
import { logError } from "../../services/ws";
import FormGroup from "../react/FormGroup.js";
import { refToJQuerySelector } from "../react/react_utils";
import { useTriliumEvent } from "../react/hooks";

type LinkType = "reference-link" | "external-link" | "hyper-link";

export default function AddLinkDialog() {
    const [ textTypeWidget, setTextTypeWidget ] = useState<TextTypeWidget>();
    const initialText = useRef<string>();
    const [ linkTitle, setLinkTitle ] = useState("");
    const hasSelection = textTypeWidget?.hasSelection();
    const [ linkType, setLinkType ] = useState<LinkType>(hasSelection ? "hyper-link" : "reference-link");
    const [ suggestion, setSuggestion ] = useState<Suggestion | null>(null);
    const [ shown, setShown ] = useState(false);
    const hasSubmittedRef = useRef(false);

    useTriliumEvent("showAddLinkDialog", ( { textTypeWidget, text }) => {
        setTextTypeWidget(textTypeWidget);
        initialText.current = text;
        setShown(true);
    });

    useEffect(() => {
        if (hasSelection) {
            setLinkType("hyper-link");
        } else {
            setLinkType("reference-link");
        }
    }, [ hasSelection ])

    async function setDefaultLinkTitle(noteId: string) {
        const noteTitle = await tree.getNoteTitle(noteId);
        setLinkTitle(noteTitle);
    }

    function resetExternalLink() {
        if (linkType === "external-link") {
            setLinkType("reference-link");
        }
    }

    useEffect(() => {
        if (!suggestion) {
            resetExternalLink();
            return;
        }

        if (suggestion.notePath) {
            const noteId = tree.getNoteIdFromUrl(suggestion.notePath);
            if (noteId) {
                setDefaultLinkTitle(noteId);
            }
            resetExternalLink();
        }

        if (suggestion.externalLink) {
            setLinkTitle(suggestion.externalLink);
            setLinkType("external-link");
        }
    }, [suggestion]);

    function onShown() {
        const $autocompleteEl = refToJQuerySelector(autocompleteRef);
        if (!initialText.current) {
            note_autocomplete.showRecentNotes($autocompleteEl);
        } else {
            note_autocomplete.setText($autocompleteEl, initialText.current);
        }

        // to be able to quickly remove entered text
        $autocompleteEl
            .trigger("focus")
            .trigger("select");
    }

    function onSubmit() {
        hasSubmittedRef.current = true;

        if (suggestion) {
            // Insertion logic in onHidden because it needs focus.
            setShown(false);
        } else {
            logError("No link to add.");
        }
    }

    const autocompleteRef = useRef<HTMLInputElement>(null);

    return (
        <Modal
            className="add-link-dialog"
            size="lg"
            maxWidth={1000}
            title={t("add_link.add_link")}
            helpPageId="QEAPj01N5f7w"
            footer={<Button text={t("add_link.button_add_link")} keyboardShortcut="Enter" />}
            onSubmit={onSubmit}
            onShown={onShown}
            onHidden={() => {
                // Insert the link.
                if (hasSubmittedRef.current && suggestion && textTypeWidget) {
                    hasSubmittedRef.current = false;

                    if (suggestion.notePath) {
                        // Handle note link
                        textTypeWidget.addLink(suggestion.notePath, linkType === "reference-link" ? null : linkTitle);
                    } else if (suggestion.externalLink) {
                        // Handle external link
                        textTypeWidget.addLink(suggestion.externalLink, linkTitle, true);
                    }
                }

                setSuggestion(null);
                setShown(false);
            }}
            show={shown}
        >
            <FormGroup label={t("add_link.note")} name="note">
                <NoteAutocomplete
                    inputRef={autocompleteRef}
                    onChange={setSuggestion}
                    opts={{
                        allowExternalLinks: true,
                        allowCreatingNotes: true
                    }}
                />
            </FormGroup>

            {!hasSelection && (
                <div className="add-link-title-settings">
                    {(linkType !== "external-link") && (
                        <>
                            <FormRadioGroup
                                name="link-type"
                                currentValue={linkType}
                                values={[
                                    { value: "reference-link", label: t("add_link.link_title_mirrors") },
                                    { value: "hyper-link", label: t("add_link.link_title_arbitrary") }
                                ]}
                                onChange={(newValue) => setLinkType(newValue as LinkType)}
                            />
                        </>
                    )}

                    {(linkType !== "reference-link" && (
                        <div className="add-link-title-form-group form-group">
                            <br/>
                            <label>
                                {t("add_link.link_title")}

                                <input className="link-title form-control" style={{ width: "100%" }}
                                    value={linkTitle}
                                    onInput={e => setLinkTitle((e.target as HTMLInputElement)?.value ?? "")}
                                />
                            </label>
                        </div>
                    ))}
                </div>
            )}
        </Modal>
    );
}
