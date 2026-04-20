export * from './sync'

// 便捷函数：创建连接到本地服务器的客户端
export function createLocalClient() {
  return createCloudApiClient({
    apiUrl: 'http://localhost:6666'
  })
}
