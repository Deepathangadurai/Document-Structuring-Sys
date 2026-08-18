import py_compile, glob, sys
errs = []
for f in glob.glob('d:/document-structuring-system/backend/app/**/*.py', recursive=True):
    try:
        py_compile.compile(f, doraise=True)
    except Exception as e:
        errs.append((f,str(e)))

if errs:
    print('ERRORS')
    for f,e in errs:
        print(f"{f}: {e}")
    sys.exit(2)
print('All python files compiled successfully')
