-- Templated drafts may select file delivery before uploading the file.
-- Keep file/text/mode consistency and the existing fixedFileId foreign key.
-- Completeness is enforced by product-state-aware writes, publication readiness
-- and checkout; Offer.status alone does not describe its parent Product's state.
ALTER TABLE "Offer"
  DROP CONSTRAINT "Offer_fixed_file_form_check",
  ADD CONSTRAINT "Offer_fixed_file_form_check"
    CHECK (
      ("fixedContentType" = 'file'
        AND "deliveryMode" = 'instant_fixed'
        AND "fixedContent" IS NULL)
      OR ("fixedContentType" <> 'file' AND "fixedFileId" IS NULL)
    );
