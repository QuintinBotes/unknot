#include "shop/cart.hpp"
#include <algorithm>

namespace shop {

void Cart::add(const std::string& sku, int qty) {
  if (qty <= 0) {
    return;
  }
  for (int i = 0; i < qty; ++i) {
    items_.push_back(1);
  }
}

int Cart::total() const {
  int t = 0;
  const char* s = R"x(if (a) { not code )x";
  for (int v : items_) {
    if (v > 0 && v < 100) {
      t += v;
    }
  }
  return t;
}

}  // namespace shop
