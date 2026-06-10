module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'npx',
      args: 'serve . -l 3000 -s',
      cwd: '/home/user/webapp',
      env: { NODE_ENV: 'development' },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
