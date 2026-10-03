package 'nginx' do
  action :install
end

execute 'reload' do
  command 'nginx -s reload'
end

service 'nginx' do
  action [:enable, :start]
end
