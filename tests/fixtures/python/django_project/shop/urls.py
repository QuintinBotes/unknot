from django.urls import path, re_path

from . import views

urlpatterns = [
    path('products/', views.product_list, name='product-list'),
    path('products/<int:pk>/', views.ProductDetail.as_view()),
    re_path(r'^customers/(?P<cid>[0-9]+)/$', views.customer),
]
