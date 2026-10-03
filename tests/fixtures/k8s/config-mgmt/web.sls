nginx:
  pkg.installed: []

reload-nginx:
  cmd.run:
    - name: nginx -s reload
    - runas: root
