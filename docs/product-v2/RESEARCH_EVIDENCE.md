# Research Evidence and Product Implications

This file records evidence used during grooming. Links should be revalidated during implementation because provider guidance and laws can change.

## Textile and production

- Brother GTX guidance describes 300 dpi at intended size, RGB mode and transparency-capable PNG/PSD/TIFF inputs.
  https://help.brother-usa.com/app/answers/detail/a_id/160820/~/gtx-pre-shipment-overview%3A-blank-garments-and-artwork
- Roland DTF workflow includes white-layer generation and transparent-data handling.
  https://www.rolanddga.com/products/printers/versastudio-by2-20
- Spoonflower uses service-specific 150 dpi/sRGB requirements and repeat/physical-size previews.
  https://support.spoonflower.com/hc/en-us/articles/204600314-Uploading-Images
  https://support.spoonflower.com/hc/en-us/articles/204474630-The-Design-Layout-Page-and-Design-Previews
- Adobe documents separations, overprinting, transparency and trapping for prepress.
  https://helpx.adobe.com/illustrator/using/printing-color-separations.html
- Embroidery digitisation converts artwork into stitch types, density, paths and thread colours; it is not ordinary image upscaling.
  https://help.printful.com/hc/en-us/articles/26233194163996-What-is-embroidery-digitization

**Implication:** no universal “textile-ready 8K” profile. Production profiles are machine/material/ink/process specific.

## PDF

- Adobe describes PDF components as structured objects including pages, fonts, images and annotations.
  https://opensource.adobe.com/dc-acrobat-sdk-docs/library/plugin/Plugins_Cos.html
- Adobe documents restrictions on editing signed PDFs.
  https://helpx.adobe.com/acrobat/desktop/e-sign-documents/learn-about-signatures/signed-pdf-limitations.html
- Adobe distinguishes permanent visible redaction from hidden-data sanitisation.
  https://helpx.adobe.com/acrobat/desktop/protect-documents/redact-pdfs/redacting-sanitizing.html

**Implication:** inspect capability first, preserve native objects where possible, never silently flatten, and verify redaction/sanitisation.

## Font licensing

- Google Fonts states its catalogue uses open-source licences and supports commercial use.
  https://developers.google.com/fonts
- Microsoft OpenType specification defines restricted, preview/print and editable embedding rights that applications must respect.
  https://learn.microsoft.com/en-us/typography/opentype/spec/os2
- Adobe Fonts terms restrict using an ordinary Adobe subscription to let SaaS customers select/apply fonts in their own dynamic content.
  https://helpx.adobe.com/fonts/web/font-licensing/font-licensing.html

**Implication:** automatic open-font resolution is valid; arbitrary proprietary font download/redistribution is not.

## E-sign

- The European Commission defines simple, advanced and qualified signature levels.
  https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/467109069/What%2Bis%2BeSignature
- EU qualified signatures rely on qualified certificates/devices and trust providers.
  https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/880312429/eSignature%2BFAQ
- India CCA describes licensed CA/ESP requirements and ASP responsibilities for consent/logs.
  https://cca.gov.in/eSign_service_faq.html
- US FTC material explains that electronic form alone does not remove legal effect and highlights consumer consent/retention requirements.
  https://www.ftc.gov/reports/report-congress-electronic-signatures-global-national-commerce-act-consumer-consent-provision

**Implication:** own the product workflow/evidence/API, use regulated trust providers where required, and never market one assurance level as universally sufficient.
