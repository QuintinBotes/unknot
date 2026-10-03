// storage and network for the prod landing zone
param location string = resourceGroup().location
param env string

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'acme${env}store'
  location: location
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: true
    minimumTlsVersion: 'TLS1_0'
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-04-01' = {
  name: 'web-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'ssh'
        properties: {
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          destinationPortRange: '22'
          priority: 100
        }
      }
    ]
  }
}

resource assign 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, 'owner')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8e3af657-a8ff-443c-a75c-2fe8c4bcb635')
    principalId: env
  }
}

module net './modules/net.bicep' = {
  name: 'net'
  params: {
    location: location
  }
}

output storageId string = storage.id
