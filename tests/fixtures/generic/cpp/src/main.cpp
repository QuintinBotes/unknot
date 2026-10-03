#include "shop/cart.hpp"
#include <fmt/core.h>
#include <iostream>

int main(int argc, char** argv) {
  shop::Cart cart;
  cart.add("sku", 1);
  return cart.total() > 0 ? 0 : 1;
}
