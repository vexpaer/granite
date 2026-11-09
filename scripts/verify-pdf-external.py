import json
from pathlib import Path
import pymupdf

source = Path('artifacts/verification/annotated-standard.pdf')
doc = pymupdf.open(source)
page = doc[0]
annotations = list(page.annots())
names = sorted(annotation.type[1] for annotation in annotations)
assert names == ['Highlight', 'Ink', 'Text', 'Underline'], names
for annotation in annotations:
    assert annotation.info.get('content'), annotation.info
    assert annotation.rect.width > 0 and annotation.rect.height > 0
page.get_pixmap(matrix=pymupdf.Matrix(2, 2), annots=True).save('artifacts/verification/pdf-external-render.png')
report = {
    'engine': 'PyMuPDF / MuPDF (independent of the application PDF.js and pdf-lib)',
    'version': str(getattr(pymupdf, 'VersionBind', getattr(pymupdf, '__version__', 'unknown'))),
    'source': str(source),
    'annotationTypes': names,
    'annotationsReadableAndEditable': True,
    'render': 'artifacts/verification/pdf-external-render.png',
}
Path('artifacts/verification/pdf-external.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
