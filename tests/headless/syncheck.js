const fs=require('fs'); const vm=require('vm');
const html=fs.readFileSync(process.argv[2],'utf8');
const re=/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi; let m, i=0, bad=0;
while((m=re.exec(html))){ i++; try{ new vm.Script(m[1],{filename:'inline'+i+'.js'}); }catch(e){ bad++; console.log('SYNTAX ERROR in inline script #'+i+': '+e.message); } }
console.log('inline scripts: '+i+', errors: '+bad); process.exit(bad?1:0);
