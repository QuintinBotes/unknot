Rails.application.routes.draw do
  resources :orders
  get 'health', to: 'health#show'

  namespace :admin do
    resources :users, only: [:index, :show]
  end
end
