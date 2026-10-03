from django.views import View

from .models import Customer, Product


def product_list(request):
    return list(Product.objects.all())


def customer(request, cid):
    return Customer.objects.get(pk=cid)


class ProductDetail(View):
    def get(self, request, pk):
        return Product.objects.get(pk=pk)
