# Product creation and editing

The pages own form state, navigation and presentation. Their request workflows
remain separate because creation is one Product + Offers draft request, while
editing saves content and offers through separate versioned requests.

- `productCreation/draft.ts` owns creation-step validation, delivery selection
  and draft payload construction.
- `productCreation/useProductCreation.ts` owns saved draft identity, availability
  loading, readiness checks and publication. It retains the current-session
  check before publication feedback.
- `productEditor/editorForm.ts` owns editor DTO parsing and image references.
- `productEditor/saveProductEdits.ts` validates edits, saves content before
  offers and recovers from content/checkout version conflicts. Progress callbacks
  publish each successful write to the page immediately, so a later failure does
  not discard the saved baseline. Conflict recovery uses those updated offers
  when reconciling local drafts with the server.

Both flows use `components/catalog/wizard/fulfillment.ts` for structured-delivery
requirements and `deliveryFields.ts` for field validation and serialization.
Editing retains its rules for existing fields and its legacy unknown-configuration
fallback. Neither workflow imports its page component.
