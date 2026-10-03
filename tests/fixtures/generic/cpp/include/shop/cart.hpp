#pragma once
#include <string>
#include <vector>

namespace shop {

class Cart : public Base {
 public:
  void add(const std::string& sku, int qty);
  int total() const;

 private:
  std::vector<int> items_;
};

}  // namespace shop
