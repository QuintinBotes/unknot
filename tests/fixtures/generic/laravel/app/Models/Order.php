<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

# A hash comment with a { brace
class Order extends Model
{
    protected $table = 'shop_orders';

    public function total(array $items, $tax)
    {
        $sum = 0;
        foreach ($items as $item) {
            if ($item > 0 and $tax) {
                $sum += $item;
            }
        }
        return $sum;
    }

    private function secret()
    {
        return <<<EOT
if (x) { not code }
EOT;
    }
}
