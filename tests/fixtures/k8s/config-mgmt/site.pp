# Puppet manifest
class profile::web {
  package { 'nginx':
    ensure => installed,
  }
  exec { 'bootstrap':
    command => '/usr/bin/true',
    user    => 'root',
  }
}
node 'web01.example.com' {
  include profile::web
}
