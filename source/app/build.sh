cd /home/claude/luc/app && cat head.part body.part tail.part > template.html && npx --prefix ../vendor esbuild src/main.js --bundle --format=iife --minify --loader:.txt=text --outfile=build/bundle.js 2>&1 | grep -iE "error|warn" ; python3 -c "
t=open('template.html').read(); b=open('build/bundle.js').read(); d=open('data.json').read()
assert '</script' not in b.lower() and '</script' not in d.lower()
open('build/index.html','w').write(t.replace('__PKG__',d).replace('__BUNDLE__',b)); print('built', len(t)+len(b)+len(d))"
