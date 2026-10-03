cmake_minimum_required(VERSION 3.20)
project(shop CXX)

# headers live in include/
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/include)

add_library(cart src/cart.cpp)
add_executable(shop_app src/main.cpp)
target_link_libraries(shop_app PRIVATE cart fmt)
add_executable(cart_test tests/cart_test.cpp)
target_link_libraries(cart_test PRIVATE cart)
