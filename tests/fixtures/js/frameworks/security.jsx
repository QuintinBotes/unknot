const cp = require('child_process');
const vm = require('vm');

function run(cmd, el, html, db, id) {
  cp.exec(cmd);
  cp.execSync('ls');
  cp.spawn('sh', ['-c', cmd], { shell: true });
  eval(cmd);
  new Function('a', cmd);
  vm.runInNewContext(cmd);
  el.innerHTML = html;
  document.write(html);
  db.query(`SELECT * FROM t WHERE id = ${id}`);
  db.raw('SELECT 1');
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
